FROM docker:1.10-dind

RUN apk add --no-cache bash curl jq parted btrfs-progs docker

COPY . /usr/src/app

WORKDIR /usr/src/app

CMD /usr/src/app/preload.sh
