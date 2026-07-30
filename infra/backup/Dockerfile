# BetterTrack offsite backup sidecar (PROJECTPLAN.md §13.4 V4-P6 arc-b).
#
# One-shot container with `age` (encrypt-only, using an owner-provided public
# recipient) + `rclone` (upload to Google Drive or any rclone remote). Invoked
# from host cron AFTER `backup.sh` produces the daily dump into the shared
# `pgbackups` volume — see infra/docker-compose.offsite.yml and docs/ops.md.
#
# Alpine 3.24 is supported through 2028-06-01 and keeps the image small
# (~40 MB). Both `age` (community) and `rclone` (main) are pinned to the
# distro release; no external downloads. Pin the manifest list so rebuilds
# cannot silently move to a different base image.
FROM alpine:3.24.1@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b

RUN apk add --no-cache \
        bash \
        age \
        rclone \
        ca-certificates \
        coreutils \
        findutils \
        tzdata

COPY offsite.sh /opt/bettertrack/offsite.sh
RUN chmod +x /opt/bettertrack/offsite.sh

ENTRYPOINT ["/bin/bash", "/opt/bettertrack/offsite.sh"]
