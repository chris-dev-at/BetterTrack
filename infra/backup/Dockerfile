# BetterTrack backup utility image.
#
# Shared by the always-on local scheduler and the optional one-shot offsite and
# restore-drill commands. The base manifest is pinned so rebuilds cannot
# silently move to a different operating system image.
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
        flock \
        gzip \
        postgresql17-client \
        tzdata

COPY backup.sh healthcheck.sh offsite.sh restore-drill.sh scheduler.sh status.sh /opt/bettertrack/
RUN chmod +x /opt/bettertrack/*.sh

ENTRYPOINT ["/bin/bash", "/opt/bettertrack/offsite.sh"]
