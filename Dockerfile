FROM docker:20.10.6-dind

# coreutils so we have the real dd, not the busybox one
RUN apk update && apk add --no-cache py3-pip parted btrfs-progs util-linux sfdisk file coreutils sgdisk

COPY ./requirements.txt /tmp/

RUN pip3 install -r /tmp/requirements.txt

COPY ./src /usr/src/app

WORKDIR /usr/src/app

CMD ["python3", "/usr/src/app/preload.py"]
