FROM alpine:3.13

WORKDIR /usr/src/app

# coreutils so we have the real dd, not the busybox one
# hadolint ignore=DL3018
RUN apk add --no-cache curl py3-pip parted btrfs-progs util-linux sfdisk file coreutils sgdisk e2fsprogs-extra

ARG DOCKER_VERSION=20.10.7

# set pipefail before running shell commands with a pipe
# https://github.com/hadolint/hadolint/wiki/DL4006
SHELL ["/bin/ash", "-eo", "pipefail", "-c"]

# install official static docker binaries
# https://github.com/docker-library/docker/blob/master/20.10/Dockerfile
RUN case "$(apk --print-arch)" in \
        'aarch64') DOCKER_ARCH='aarch64' ;; \
        'armhf') DOCKER_ARCH='armel' ;; \
        'armv7') DOCKER_ARCH='armhf' ;; \
        'x86_64') DOCKER_ARCH='x86_64' ;; \
        *) echo >&2 "error: unsupported architecture ($(apk --print-arch))"; exit 1 ;; \
    esac && \
    curl -fsSL https://download.docker.com/linux/static/stable/$DOCKER_ARCH/docker-$DOCKER_VERSION.tgz | \
        tar xzv --strip-components 1 -C /usr/local/bin/ && \
    dockerd --version; docker --version

COPY requirements.txt ./

RUN pip3 install --no-cache-dir -r requirements.txt

COPY src/ ./

CMD ["python3", "/usr/src/app/preload.py"]