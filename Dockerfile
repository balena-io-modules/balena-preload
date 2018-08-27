FROM docker:17.10.0-ce-dind

# coreutils so we have the real dd, not the busybox one
RUN apk update && apk add --no-cache python3 parted btrfs-progs docker util-linux sfdisk file coreutils sgdisk

COPY ./requirements.txt /tmp/

RUN pip3 install -r /tmp/requirements.txt

COPY ./src /usr/src/app

WORKDIR /usr/src/app

CMD ["python3", "/usr/src/app/preload.py"]
