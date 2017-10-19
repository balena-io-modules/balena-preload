FROM docker:17.10.0-ce-dind

# TODO: remove parted
RUN apk update && apk add --no-cache python3 parted btrfs-progs docker util-linux sfdisk file

COPY ./requirements.txt /tmp/

RUN pip3 install -r /tmp/requirements.txt

COPY ./src /usr/src/app

WORKDIR /usr/src/app

CMD /usr/src/app/preload.py
