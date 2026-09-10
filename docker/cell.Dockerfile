# A small cell image that can still be a machine.
#
# The default (`node:22-slim`) is Debian: it has `script`, so the Terminal gets a
# real pseudo-terminal — job control, vim, full-screen programs — and it has Node,
# so a dev server and the page first run puts up both work. It costs about 200 MB
# to pull, once.
#
# This is the small alternative for people who would rather have the megabytes:
# Alpine, plus the two packages that make the difference. `util-linux` is where
# Alpine keeps `script` (its busybox is built without the applet), and `nodejs` is
# what runs anything you write.
#
#   docker build -f docker/cell.Dockerfile -t sandboxos-cell:alpine .
#   SANDBOXOS_CELL_IMAGE=sandboxos-cell:alpine npm start
#
# A Cell whose image no longer matches this setting is recreated on its next boot
# — the volume is a bind mount and is untouched — so changing it takes effect
# without anybody going and deleting containers by hand.

FROM alpine:latest

RUN apk add --no-cache \
      util-linux \
      nodejs \
      npm \
      git \
      curl \
      ca-certificates

WORKDIR /sandbox
