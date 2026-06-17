// Firecracker Cell backend — L2 microVM isolation (docs/04).
//
// Each Sandbox runs inside a full KVM microVM via Firecracker's HTTP API (Unix
// socket). Provides hardware-enforced isolation beyond what Linux namespaces
// give containers. Requires:
//   - Linux host with /dev/kvm accessible (group kvm or root)
//   - `firecracker` binary in PATH
//   - `qemu-img` for overlay rootfs creation
//   - Base rootfs image at $FC_ROOTFS (ext4, ≥512 MB)
//   - TAP interface pool + host-side IP routing (see scripts/setup-microvm.sh)
//
// On macOS this class still loads but `ensureRunning()` throws "requires Linux".
// `cell.js` resolves the backend tier so non-Linux hosts never reach this.
//
// SSH is used for exec/stream/interactive. The cell image has a baked-in
// authorized_keys for the shared host keypair (~/.sandboxos/cell-key.pub).
// The keypair is generated on first use.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import config from "../../config/src/config.js";
import { allocateTap, releaseTap, getTapForSandbox } from "../../control-db/src/registry.js";

const WORKDIR = "/sandbox";
const GUEST_IP = "172.20.0.2";
const SSH_USER = "root";
const KEY_DIR = path.join(os.homedir(), ".sandboxos");
const HOST_KEY = path.join(KEY_DIR, "cell-key");
const HOST_KEY_PUB = HOST_KEY + ".pub";

// ── Helpers ──────────────────────────────────────────────────────────────────

function sh(cmd, args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs },
      (err, stdout, stderr) => resolve({
        stdout: stdout ?? "", stderr: stderr ?? "",
        code: err && typeof err.code === "number" ? err.code : err ? 1 : 0,
      }));
  });
}

function ensureHostKey() {
  if (fs.existsSync(HOST_KEY)) return;
  fs.mkdirSync(KEY_DIR, { recursive: true });
  const r = require("child_process").spawnSync(
    "ssh-keygen", ["-t", "ed25519", "-N", "", "-f", HOST_KEY],
    { stdio: "ignore" }
  );
  if (r.status !== 0) throw new Error("Failed to generate cell SSH keypair");
}

// ── Firecracker HTTP-over-socket client ──────────────────────────────────────

function fcApi(socketPath, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request({
      socketPath,
      path: urlPath,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Backend class ─────────────────────────────────────────────────────────────

export class FirecrackerBackend {
  constructor(sandbox, { memMb = 512, vcpus = 1 } = {}) {
    this.sandbox = sandbox;
    this.backend = "firecracker";
    this.root = sandbox.volume_path;
    this.socketPath = `/tmp/sandboxos-fc-${sandbox.id}.sock`;
    this.pidFile = `/tmp/sandboxos-fc-${sandbox.id}.pid`;
    this.overlayPath = path.join(this.root, "rootfs.qcow2");
    this.memMb = memMb;
    this.vcpus = vcpus;
    this._proc = null;
  }

  // ── Config builders (pure — testable without a running VM) ────────────────

  _bootSourceConfig() {
    return {
      kernel_image_path: config.fcKernelImage ?? "/var/lib/sandboxos/vmlinux",
      boot_args: "console=ttyS0 reboot=k panic=1 pci=off ro",
    };
  }

  _machineConfig() {
    return { vcpu_count: this.vcpus, mem_size_mib: this.memMb };
  }

  _driveConfig() {
    return {
      drive_id: "rootfs",
      path_on_host: this.overlayPath,
      is_root_device: true,
      is_read_only: false,
    };
  }

  _networkConfig(tapDevice) {
    return {
      iface_id: "eth0",
      guest_mac: "AA:FC:00:00:00:01",
      host_dev_name: tapDevice,
    };
  }

  // ── API wrappers ──────────────────────────────────────────────────────────

  async _api(method, urlPath, body) {
    return fcApi(this.socketPath, method, urlPath, body);
  }

  // ── Readiness polls ───────────────────────────────────────────────────────

  async _waitForSocket(timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fs.existsSync(this.socketPath)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Firecracker socket did not appear: ${this.socketPath}`);
  }

  async _waitForSsh(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await sh("ssh", [
        "-i", HOST_KEY, "-o", "StrictHostKeyChecking=no",
        "-o", "ConnectTimeout=2", "-o", "BatchMode=yes",
        `${SSH_USER}@${GUEST_IP}`, "true",
      ], { timeoutMs: 3_000 });
      if (r.code === 0) return;
      await new Promise((r2) => setTimeout(r2, 500));
    }
    throw new Error("SSH not reachable in guest VM");
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  ensureRunning() {
    if (this._boot) return this._boot;
    this._boot = this._doEnsure().finally(() => { this._boot = null; });
    return this._boot;
  }

  async _doEnsure() {
    if (process.platform !== "linux") {
      throw new Error("FirecrackerBackend requires Linux with /dev/kvm");
    }
    if (!fs.existsSync("/dev/kvm")) {
      throw new Error("FirecrackerBackend requires /dev/kvm (install KVM or use Docker backend)");
    }

    ensureHostKey();
    fs.mkdirSync(this.root, { recursive: true });

    // Check if already running via pidfile + socket.
    if (fs.existsSync(this.pidFile) && fs.existsSync(this.socketPath)) {
      const pid = parseInt(fs.readFileSync(this.pidFile, "utf8").trim(), 10);
      try { process.kill(pid, 0); return { state: "running" }; } catch { /* stale pidfile */ }
    }

    await this._createOverlay();

    // Restore from snapshot if one exists (fast resume vs cold boot).
    const snapshotPath = path.join(this.root, "mem.snap");
    const stateFile    = path.join(this.root, "vm.snap");
    if (fs.existsSync(snapshotPath) && fs.existsSync(stateFile)) {
      await this._resumeVm(snapshotPath, stateFile);
    } else {
      await this._startVm();
    }
    return { state: "running" };
  }

  async _createOverlay() {
    if (fs.existsSync(this.overlayPath)) return;
    const baseRootfs = config.fcRootfs ?? process.env.FC_ROOTFS;
    if (!baseRootfs) throw new Error("FC_ROOTFS / config.fcRootfs must point to a base ext4 image");
    const r = await sh("qemu-img", ["create", "-f", "qcow2", "-b", baseRootfs, "-F", "raw", this.overlayPath]);
    if (r.code !== 0) throw new Error(`qemu-img overlay failed: ${r.stderr.trim()}`);
  }

  async _launchProcess() {
    if (fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath);
    this._proc = spawn(
      "firecracker",
      ["--api-sock", this.socketPath, "--level", "Warning"],
      { stdio: ["ignore", "ignore", "ignore"], detached: true }
    );
    this._proc.unref();
    fs.writeFileSync(this.pidFile, String(this._proc.pid));
    await this._waitForSocket(10_000);
  }

  async _startVm() {
    const tap = allocateTap(this.sandbox.id);
    await this._launchProcess();

    await this._api("PUT", "/boot-source", this._bootSourceConfig());
    await this._api("PUT", "/machine-config", this._machineConfig());
    await this._api("PUT", "/drives/rootfs", this._driveConfig());
    await this._api("PUT", "/network-interfaces/eth0", this._networkConfig(tap));
    await this._api("PUT", "/actions", { action_type: "InstanceStart" });

    await this._waitForSsh(30_000);
  }

  async _resumeVm(snapshotPath, stateFile) {
    // Restore from a previously saved Diff snapshot — skips kernel boot (~200ms).
    const tap = getTapForSandbox(this.sandbox.id) ?? allocateTap(this.sandbox.id);
    await this._launchProcess();

    await this._api("PUT", "/snapshot/load", {
      snapshot_path: stateFile,
      mem_file_path: snapshotPath,
      enable_diff_snapshots: true,
      resume_vm: true,
    });

    // Re-attach network interface (snapshot restore drops it).
    await this._api("PUT", "/network-interfaces/eth0", this._networkConfig(tap));

    await this._waitForSsh(15_000);
  }

  // ── Exec interface (SSH-based) ────────────────────────────────────────────

  _sshArgs(extraFlags = []) {
    return [
      "-i", HOST_KEY,
      "-o", "StrictHostKeyChecking=no",
      "-o", "BatchMode=yes",
      "-o", "ServerAliveInterval=10",
      ...extraFlags,
      `${SSH_USER}@${GUEST_IP}`,
    ];
  }

  async exec(command, { timeoutMs = 30_000, env = {} } = {}) {
    await this.ensureRunning();
    const envPrefix = Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
    const fullCmd = envPrefix ? `cd ${WORKDIR} && ${envPrefix} sh -c ${JSON.stringify(command)}` : `cd ${WORKDIR} && sh -c ${JSON.stringify(command)}`;
    return sh("ssh", [...this._sshArgs(), fullCmd], { timeoutMs });
  }

  async execStream(command, callback, { timeoutMs = 30_000, env = {} } = {}) {
    await this.ensureRunning();
    const envPrefix = Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
    const fullCmd = envPrefix ? `cd ${WORKDIR} && ${envPrefix} sh -c ${JSON.stringify(command)}` : `cd ${WORKDIR} && sh -c ${JSON.stringify(command)}`;
    const proc = spawn("ssh", this._sshArgs([fullCmd]));
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    proc.stdout.on("data", (d) => callback({ type: "stdout", chunk: d.toString() }));
    proc.stderr.on("data", (d) => callback({ type: "stderr", chunk: d.toString() }));
    proc.on("close", (code) => { clearTimeout(timer); callback({ type: "done", code: code ?? 1 }); });
    return proc;
  }

  async execInteractive(onData, onClose, { env = {}, cols = 80, rows = 24 } = {}) {
    await this.ensureRunning();
    const envVars = Object.entries({ ...env, TERM: "xterm-256color", COLUMNS: String(cols), LINES: String(rows) })
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
    const initCmd = `${envVars} cd ${WORKDIR} && exec sh -i`;
    // -t -t forces PTY allocation even over a non-tty stdin — gives real resize.
    const proc = spawn("ssh", [...this._sshArgs(["-t", "-t"]), initCmd], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("close", onClose);
    return {
      write(data) { try { proc.stdin.write(data); } catch {} },
      kill()      { try { proc.kill("SIGKILL"); } catch {} },
      resize(newCols, newRows) {
        // ANSI escape sequence to tell the terminal emulator inside the guest
        // to resize: CSI 8 ; rows ; cols t (xterm "set window size in chars").
        try { proc.stdin.write(`\x1b[8;${newRows};${newCols}t`); } catch {}
      },
    };
  }

  // ── Snapshot / restore ────────────────────────────────────────────────────

  async _snapshot() {
    const snapshotPath = path.join(this.root, "mem.snap");
    const stateFile = path.join(this.root, "vm.snap");
    await this._api("PATCH", "/vm", { state: "Paused" });
    await this._api("PUT", "/snapshot/create", {
      snapshot_type: "Diff",
      snapshot_path: stateFile,
      mem_file_path: snapshotPath,
    });
    return { snapshotPath, stateFile };
  }

  async stop() {
    this._boot = null;
    // Best-effort snapshot so the next wake can restore.
    try { await this._snapshot(); } catch {}
    try {
      if (fs.existsSync(this.pidFile)) {
        const pid = parseInt(fs.readFileSync(this.pidFile, "utf8").trim(), 10);
        process.kill(pid, "SIGTERM");
      }
    } catch {}
    return { state: "stopped" };
  }

  async destroy() {
    this._boot = null;
    try {
      if (fs.existsSync(this.pidFile)) {
        const pid = parseInt(fs.readFileSync(this.pidFile, "utf8").trim(), 10);
        process.kill(pid, "SIGKILL");
      }
    } catch {}
    for (const f of [this.socketPath, this.pidFile]) {
      try { fs.unlinkSync(f); } catch {}
    }
    releaseTap(this.sandbox.id);
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}
