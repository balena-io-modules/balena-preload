FROM docker:17.06.1-ce-dind

RUN apk update && apk add --no-cache python3 parted btrfs-progs docker util-linux inotify-tools sfdisk

COPY ./requirements.txt /tmp/

RUN pip3 install -r /tmp/requirements.txt

COPY ./src /usr/src/app

WORKDIR /usr/src/app

CMD /usr/src/app/preload.py
