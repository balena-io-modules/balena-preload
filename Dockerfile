# avoid alpine 3.13 or later due to this issue on armv7
# https://wiki.alpinelinux.org/wiki/Release_Notes_for_Alpine_3.13.0#time64_requirements
FROM alpine:3.24@sha256:8ddefa941e689fc29abcdeb8dae3b3c6d139cc08ce9a52633931160701770685

WORKDIR /usr/src/app

# coreutils so we have the real dd, not the busybox one
# hadolint ignore=DL3018
RUN apk add --no-cache curl py3-pip parted btrfs-progs util-linux sfdisk file coreutils sgdisk e2fsprogs-extra docker

COPY requirements.txt ./

RUN pip3 install --no-cache-dir -r requirements.txt --break-system-packages

COPY src/ ./

CMD ["python3", "/usr/src/app/preload.py"]
