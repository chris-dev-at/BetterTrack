# BetterTrack offsite backup sidecar (PROJECTPLAN.md §13.4 V4-P6 arc-b).
#
# One-shot container with `age` (encrypt-only, using an owner-provided public
# recipient) + `rclone` (upload to Google Drive or any rclone remote). Invoked
# from host cron AFTER `backup.sh` produces the daily dump into the shared
# `pgbackups` volume — see infra/docker-compose.offsite.yml and docs/ops.md.
#
# Alpine 3.20 keeps the image small (~40 MB). Both `age` (community) and
# `rclone` (main) are pinned to the distro release; no external downloads.
FROM alpine:3.20

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
