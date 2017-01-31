FROM docker:1.10-dind

RUN apk update && apk add --no-cache bash curl jq parted btrfs-progs docker util-linux

COPY ./src /usr/src/app

WORKDIR /usr/src/app

CMD /usr/src/app/preload.sh
