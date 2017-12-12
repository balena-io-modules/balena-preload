#!/usr/bin/python3 -u
import json
import os
import sys

from contextlib import contextmanager
from functools import partial
from logging import getLogger, INFO, StreamHandler
from math import ceil, floor
from re import search
from sh import (
    btrfs,
    dd,
    docker,
    dockerd,
    file,
    fsck,
    losetup,
    mount,
    parted,
    resize2fs,
    sfdisk,
    sgdisk,
    umount,
    ErrorReturnCode,
)
from shutil import copyfile, rmtree
from tempfile import mkdtemp, NamedTemporaryFile

os.environ["LANG"] = "C"

IMAGE = "/img/resin.img"

SECTOR_SIZE = 512
MBR_SIZE = 512
GPT_SIZE = SECTOR_SIZE * 34

SPLASH_IMAGE_FROM = "/img/resin-logo.png"
SPLASH_IMAGE_TO = "/splash/resin-logo.png"

DOCKER_HOST = "tcp://0.0.0.0:{}".format(os.environ.get("DOCKER_PORT") or 8000)

log = getLogger(__name__)
log.setLevel(INFO)
log.addHandler(StreamHandler())


PARTITIONS_CACHE = {}


def get_partitions(image):
    return {p.label: p for p in PartitionTable(image).partitions if p.label}


def prepare_global_partitions():
    partitions = os.environ.get("PARTITIONS")
    if partitions is not None:
        partitions = json.loads(partitions)
        result = {}
        for label, data in partitions.items():
            result[label] = FilePartition(data["image"], label)
        return result
    return get_partitions(IMAGE)


@contextmanager
def losetup_context_manager(image, offset=None, size=None):
    args = ["-f", "--show"]
    if offset is not None:
        args.extend(["--offset", offset])
    if size is not None:
        args.extend(["--sizelimit", size])
    args.append(image)
    device = losetup(*args).stdout.decode("utf8").strip()
    yield device
    losetup("-d", device)


@contextmanager
def device_mount_context_manager(device):
    mountpoint = mkdtemp()
    mount(device, mountpoint)
    yield mountpoint
    umount(mountpoint)
    os.rmdir(mountpoint)


@contextmanager
def mount_context_manager(image, offset=None, size=None):
    with losetup_context_manager(image, offset, size) as device:
        with device_mount_context_manager(device) as mountpoint:
            yield mountpoint


class FilePartition(object):
    def __init__(self, image, label):
        self.image = image
        self.label = label

    def losetup_context_manager(self):
        return losetup_context_manager(self.image)

    def mount_context_manager(self):
        return mount_context_manager(self.image)

    def resize(self, additional_bytes):
        expand_file(self.image, additional_bytes)
        expand_filesystem(self)

    def str(self):
        return self.image


class Partition(object):
    def __init__(
        self,
        partition_table,
        number,
        node=None,
        start=None,
        size=None,
        type=None,
        uuid=None,
        name=None,
        bootable=False,
    ):
        self.partition_table = partition_table
        self.number = number
        self.parent = None
        self.node = node
        self.start = start
        self.size = size
        self.type = type
        self.uuid = uuid
        self.name = name
        self.bootable = bootable
        # label, not part of the sfdisk script
        self.label = self._get_label()

    def _get_label(self):
        with self.losetup_context_manager() as device:
            out = file("-s", device).stdout.decode("utf8").strip()
            # "label:" is for fat partitions,
            # "volume name" is for ext partitions
            # "BTRFS Filesystem label" is for btrfs partitions
            match = search(
                '(BTRFS Filesystem label|label:|volume name) "(.*)"',
                out,
            )
            if match is not None:
                return match.groups()[1].strip()

    def set_parent(self, parent):
        # For logical partitions on MBR disks we store the parent extended
        # partition
        assert self.partition_table.label == "dos"
        self.parent = parent

    @property
    def image(self):
        return self.partition_table.image

    @property
    def end(self):
        # last sector (included)
        return self.start + self.size - 1

    @property
    def start_bytes(self):
        return self.start * SECTOR_SIZE

    @property
    def size_bytes(self):
        return self.size * SECTOR_SIZE

    @property
    def end_bytes(self):
        # last byte (included)
        return self.start_bytes + self.size_bytes - 1

    def is_included_in(self, other):
        return (
            other.start <= self.start <= other.end and
            other.start <= self.end <= other.end
        )

    def is_extended(self):
        return self.partition_table.label == "dos" and self.type == "f"

    def is_last(self):
        # returns True if this partition is the last on the disk
        return self == self.partition_table.get_partitions_in_disk_order()[-1]

    def get_sfdisk_line(self):
        result = "{} : start={}, size={}, type={}".format(
            self.node,
            self.start,
            self.size,
            self.type
        )
        if self.uuid is not None:
            result += ", uuid={}".format(self.uuid)
        if self.name is not None:
            result += ', name="{}"'.format(self.name)
        if self.bootable:
            result += ", bootable"
        return result

    def losetup_context_manager(self):
        return losetup_context_manager(
            self.image,
            self.start_bytes,
            self.size_bytes,
        )

    def mount_context_manager(self):
        return mount_context_manager(
            self.image,
            self.start_bytes,
            self.size_bytes,
        )

    def str(self):
        return "partition n°{} of {}".format(self.number, self.image)

    def _resize_last_partition_of_disk_image(self, additional_bytes):
        # This is the simple case: expand the partition and its parent extended
        # partition if it is a logical one.
        additional_sectors = additional_bytes // SECTOR_SIZE
        # Expand image size
        expand_file(self.image, additional_bytes)
        if self.partition_table.label == "gpt":
            # Move backup GPT data structures to the end of the disk.
            # This is required because we resized the image.
            sgdisk("-e", self.image)
        parted_args = [self.image]
        if self.parent is not None:
            log.info("Expanding extended {}".format(self.parent.str()))
            # Resize the extended partition
            parted_args.extend(["resizepart", self.parent.number, "100%"])
            self.parent.size += additional_sectors
        # Resize the partition itself
        log.info(
            "Expanding{} {}".format(
                " logical" if self.parent is not None else "",
                self.str(),
            )
        )
        parted_args.extend(["resizepart", self.number, "100%"])
        parted(*parted_args, _in="fix\n")
        self.size += additional_sectors

    def _resize_partition_on_disk_image(self, additional_bytes):
        # This function expects the partitions to be in disk order: it will
        # fail if there are primary partitions after an extended one containing
        # logical partitions.
        # Resizing logical partitions that are not the last on the disk is not
        # implemented
        assert self.parent is None
        partition_table = self.partition_table
        image = self.image
        # Create a new temporary file of the correct size
        tmp = NamedTemporaryFile(dir=os.path.dirname(image), delete=False)
        tmp.truncate(file_size(image) + additional_bytes)
        tmp.close()
        # Update the partition table
        additional_sectors = additional_bytes // SECTOR_SIZE
        # resize the partition
        self.size += additional_sectors
        # move the partitions after
        for part in partition_table.partitions[self.number:]:
            part.start += additional_sectors
        # update last lba
        if partition_table.lastlba is not None:
            partition_table.lastlba += additional_sectors
        sfdisk(tmp.name, _in=partition_table.get_sfdisk_script())
        # Now we copy the data from the image to the temporary file
        copy = partial(
            ddd,
            _if=image,
            of=tmp.name,
            bs=1024 ** 2,  # one MiB
            conv="notrunc",
            iflag="count_bytes,skip_bytes",  # count and skip in bytes
            oflag="seek_bytes",  # seek in bytes
        )
        # Copy across any data that's located between the MBR and the first
        # partition (some devices rely on the bootloader being there, like the
        # Variscite DART-6UL)
        if self.partition_table.label == "dos":
            copy(
                skip=MBR_SIZE,
                seek=MBR_SIZE,
                count=partition_table.partitions[0].start_bytes - MBR_SIZE,
            )
        elif self.partition_table.label == "gpt":
            copy(
                skip=GPT_SIZE,
                seek=GPT_SIZE,
                count=partition_table.partitions[0].start_bytes - GPT_SIZE,
            )
        # TODO: if we copy an extended partition, there is no need to copy its
        # logical partitions.
        # Copy partitions before and the partition itself
        for part in partition_table.partitions[:self.number]:
            # No need to copy extended partitions, we'll copy their logical
            # partitions
            if not part.is_extended():
                copy(
                    skip=part.start_bytes,
                    seek=part.start_bytes,
                    count=part.size_bytes,
                )
        # Copy partitions after.
        for part in partition_table.partitions[self.number:]:
            if not part.is_extended():
                copy(
                    skip=part.start_bytes,
                    seek=part.start_bytes + additional_bytes,
                    count=part.size_bytes,
                )
        # Replace the original image contents.
        ddd(_if=tmp.name, of=image, bs=1024 ** 2)

    def resize(self, additional_bytes):
        # Is it the last partition on the disk?
        if self.is_last():
            self._resize_last_partition_of_disk_image(additional_bytes)
        else:
            self._resize_partition_on_disk_image(additional_bytes)
        expand_filesystem(self)


class PartitionTable(object):
    def __init__(self, image):
        self.image = image
        data = json.loads(
            sfdisk("--dump", "--json", image).stdout.decode("utf8")
        )["partitiontable"]
        self.label = data["label"]
        assert self.label in ("dos", "gpt")
        self.id = data["id"]
        self.device = data["device"]
        self.unit = data["unit"]
        self.firstlba = data.get("firstlba")
        self.lastlba = data.get("lastlba")
        self.partitions = []
        extended_partition = None
        for number, partition_data in enumerate(data["partitions"], 1):
            part = Partition(self, number, **partition_data)
            if part.is_extended():
                extended_partition = part
            if extended_partition and part.is_included_in(extended_partition):
                part.set_parent(extended_partition)
            self.partitions.append(part)

    def get_partitions_in_disk_order(self):
        # Returns the partitions in the same order that they are on the disk
        # This excludes extended partitions.
        partitions = (p for p in self.partitions if not p.is_extended())
        return sorted(partitions, key=lambda p: p.start)

    def get_sfdisk_script(self):
        result = (
            "label: {}\n"
            "label-id: {}\n"
            "device: {}\n"
            "unit: {}\n"
        ).format(self.label, self.id, self.device, self.unit)
        if self.firstlba is not None:
            result += "first-lba: {}\n".format(self.firstlba)
        if self.lastlba is not None:
            result += "last-lba: {}\n".format(self.lastlba)
        result += "\n"
        result += "\n".join(p.get_sfdisk_line() for p in self.partitions)
        return result


def get_filesystem(device):
    line = fsck("-N", device).stdout.decode("utf8").strip().split("\n")[1]
    return line.rsplit(" ", 2)[-2].split(".")[1]


def expand_filesystem(partition):
    with partition.losetup_context_manager() as device:
        # Detects the partition filesystem (ext{2,3,4} or btrfs) and uses the
        # appropriate tool to expand the filesystem to all the available space.
        fs = get_filesystem(device)
        log.info(
            "Resizing {} filesystem of {} using {}".format(
                fs,
                partition.str(),
                device,
            )
        )
        if fs.startswith("ext"):
            try:
                status = fsck("-p", "-f", device, _ok_code=[0, 1, 2])
                if status.exit_code == 0:
                    log.info("File system OK")
                else:
                    log.warning("File system errors corrected")
            except ErrorReturnCode:
                raise Exception("File system errors could not be corrected")
            resize2fs("-f", device)
        elif fs == "btrfs":
            # For btrfs we need to mount the fs for resizing.
            with mount_context_manager(device) as mountpoint:
                btrfs("filesystem", "resize", "max", mountpoint)


def expand_file(path, additional_bytes):
    with open(path, "a") as f:
        size = f.tell()
        f.truncate(size + additional_bytes)


def fix_rce_docker(mountpoint):
    """
    Removes the /rce folder if a /docker folder exists.
    Returns "<mountpoint>/docker" if this folder exists, "<mountpoint>/rce"
    otherwise.
    """
    _docker_dir = mountpoint + "/docker"
    _rce_dir = mountpoint + "/rce"
    if os.path.isdir(_docker_dir):
        if os.path.isdir(_rce_dir):
            rmtree(_rce_dir)
        return _docker_dir
    else:
        return _rce_dir


def start_docker_daemon(storage_driver, docker_dir):
    """Starts the docker daemon and waits for it to be ready."""
    running_dockerd = dockerd(
        storage_driver=storage_driver,
        data_root=docker_dir,
        host=DOCKER_HOST,
        _bg=True,
    )
    log.info("Waiting for Docker to start...")
    ok = False
    while not ok:
        # dockerd should not exit, if it does, we'll throw an exception.
        if running_dockerd.process.exit_code is not None:
            # There is no reason for dockerd to exit with a 0 status now.
            assert running_dockerd.process.exit_code != 0
            # This will raise an sh.ErrorReturnCode_X exception.
            running_dockerd.wait()
        # Check that we can connect to dockerd.
        output = docker("--host", DOCKER_HOST, "version", _ok_code=[0, 1])
        ok = output.exit_code == 0
    log.info("Docker started")
    return running_dockerd


def read_file(name):
    with open(name, "rb") as f:
        return f.read()


def write_file(name, content):
    with open(name, "wb") as f:
        f.write(content)


@contextmanager
def docker_context_manager(storage_driver, mountpoint):
    docker_dir = fix_rce_docker(mountpoint)
    # If we don't remove <part6>/<docker|rce>/network/files/local-kv.db and the
    # preload container was started with bridged networking, the following
    # dockerd is not reachable from the host.
    local_kv_db_path = "{}/network/files/local-kv.db".format(docker_dir)
    kv_file_existed = (
        os.path.exists(local_kv_db_path) and os.path.isfile(local_kv_db_path)
    )
    if kv_file_existed:
        local_kv_db_content = read_file(local_kv_db_path)
        os.remove(local_kv_db_path)
    running_dockerd = start_docker_daemon(storage_driver, docker_dir)
    yield
    running_dockerd.terminate()
    running_dockerd.wait()
    if kv_file_existed:
        write_file(local_kv_db_path, local_kv_db_content)


def write_apps_json(data, output):
    """Writes data dict to output as json"""
    with open(output, "w") as f:
        json.dump([data], f, indent=4, sort_keys=True)


def replace_splash_image(image=None):
    """
    Replaces the resin-logo.png used on boot splash to allow a more branded
    experience.
    """
    if os.path.isfile(SPLASH_IMAGE_FROM):
        boot = get_partition("resin-boot", image)
        with boot.mount_context_manager() as mpoint:
            path = mpoint + SPLASH_IMAGE_TO
            if os.path.isdir(os.path.dirname(path)):
                log.info("Replacing splash image")
                copyfile(SPLASH_IMAGE_FROM, path)
            else:
                log.info(
                    "No splash folder on the boot partition, the splash image "
                    "won't be inserted."
                )
    else:
        log.info("Leaving splash image alone")


def start_dockerd_and_wait_for_stdin(app_data, image=None):
    driver = get_docker_storage_driver(image)
    part = get_partition("resin-data", image)
    with part.mount_context_manager() as mpoint:
        write_apps_json(app_data, mpoint + "/apps.json")
        with docker_context_manager(driver, mpoint):
            # Signal that Docker is ready.
            print(json.dumps({}))
            # Wait for the js to finish its job.
            input()


def round_to_sector_size(size, sector_size=SECTOR_SIZE):
    sectors = size / sector_size
    if not sectors.is_integer():
        sectors = floor(sectors) + 1
    return int(sectors * sector_size)


def file_size(path):
    with open(path, "a") as f:
        return f.tell()


def ddd(**kwargs):
    # dd helper
    return dd(*("{}={}".format(k.lstrip("_"), v) for k, v in kwargs.items()))


def get_json(partition_name, path, image=None):
    part = get_partition(partition_name, image)
    if part:
        with part.mount_context_manager() as mountpoint:
            try:
                with open(os.path.join(mountpoint, path)) as f:
                    return json.load(f)
            except FileNotFoundError:
                pass


def get_config(image=None):
    return (
        get_json("resin-boot", "config.json", image=image) or  # resinOS 1.26+
        get_json("resin-conf", "config.json", image=image) or  # resinOS 1.8
        get_json("flash-conf", "config.json", image=image)  # resinOS 1.8 flash
    )


def get_device_type(image=None):
    result = get_json("resin-boot", "device-type.json", image=image)
    if result is None:
        result = get_json("flash-boot", "device-type.json", image=image)
    return result


def get_device_type_slug():
    device_type = get_device_type()
    if device_type is not None:
        return device_type["slug"]
    return get_config()["deviceType"]


def preload(additional_bytes, app_data, image=None):
    replace_splash_image(image)
    part = get_partition("resin-data", image)
    part.resize(additional_bytes)
    start_dockerd_and_wait_for_stdin(app_data, image)


def get_inner_image_path(root_mountpoint):
    opt = os.path.join(root_mountpoint, "opt")
    files = os.listdir(opt)
    assert len(files) == 1, "More than one file in root partition's /opt"
    return os.path.join(opt, files[0])


def _list_images(image=None):
    driver = get_docker_storage_driver(image=image)
    part = get_partition("resin-data", image)
    with part.mount_context_manager() as mountpoint:
        with docker_context_manager(driver, mountpoint):
            output = docker(
                "--host",
                DOCKER_HOST,
                "images",
                "--all",
                "--format",
                "{{.Repository}}",
            )
            return output.strip().split("\n")


def list_images():
    flasher_root = get_partition("flash-rootA")
    if flasher_root:
        with flasher_root.mount_context_manager() as mountpoint:
            inner_image_path = get_inner_image_path(mountpoint)
            return _list_images(inner_image_path)
    return _list_images()


def is_non_empty_folder(folder):
    # True if the folder has at least one file not starting with a dot.
    if not os.path.exists(folder) or not os.path.isdir(folder):
        return False
    return any(f for f in os.listdir(folder) if not f.startswith("."))


def find_non_empty_folder_in_path(path, child_dir=""):
    # If child_dir is not given, returns any non empty folder like <path>/...;
    # else, returns any non empty folder like <path>/.../<child_dir>
    # where ... can be any subfodler of <path>.
    if os.path.exists(path) and os.path.isdir(path):
        for folder in os.listdir(path):
            folder_path = os.path.join(path, folder, child_dir)
            if is_non_empty_folder(folder_path):
                return folder_path


def find_docker_aufs_root(mountpoint):
    # We're looking for a /<docker|balena>/aufs/diff/<xxxxxxxxxxxxx>/ folder
    # with some files not starting with a '.'
    for name in ("docker", "balena"):
        path = os.path.join(mountpoint, name, "aufs", "diff")
        if os.path.isdir(path):
            return find_non_empty_folder_in_path(path)


def find_docker_overlay2_root(mountpoint):
    # We're looking for a /<docker|balena>/overlay2/<xxxxxxxxxxxxx>/diff
    # folder with some files not starting with a '.'
    for name in ("docker", "balena"):
        path = os.path.join(mountpoint, name, "overlay2")
        if os.path.isdir(path):
            return find_non_empty_folder_in_path(path, "diff")


def get_docker_service_file_path(folder):
    for name in ("docker", "balena"):
        fpath = os.path.join(
            folder,
            "lib",
            "systemd",
            "system",
            name + ".service",
        )
        if os.path.exists(fpath):
            return fpath


def get_docker_service_file_content(image=None):
    part = get_partition("resin-rootA", image)
    with part.mount_context_manager() as mountpoint:
        docker_root = find_docker_aufs_root(mountpoint)
        if docker_root is None:
            docker_root = find_docker_overlay2_root(mountpoint)
        if docker_root is not None:
            path = get_docker_service_file_path(docker_root)
        else:
            path = get_docker_service_file_path(mountpoint)
        with open(path) as f:
            return f.read()


def find_one_of(lst, *args):
    for elem in args:
        index = lst.index(elem)
        if index != -1:
            return index
    return -1


def get_docker_storage_driver(image=None):
    for line in get_docker_service_file_content(image).strip().split("\n"):
        if line.startswith("ExecStart="):
            words = line.split()
            position = find_one_of(words, "-s", "--storage-driver")
            if position != -1 and position < len(words) - 1:
                return words[position + 1]
    assert False, "Docker storage driver could not be found"


def main_preload(app_data, container_size):
    # Size will be increased by 110% of the container size
    additional_bytes = round_to_sector_size(ceil(int(container_size) * 1.1))
    flasher_root = get_partition("flash-rootA")
    if flasher_root:
        flasher_root.resize(additional_bytes)
        with flasher_root.mount_context_manager() as mountpoint:
            inner_image_path = get_inner_image_path(mountpoint)
            log.info(
                "This is a flasher image, preloading to /{} on {}".format(
                    inner_image_path.split("/", 2)[2],
                    flasher_root.str(),
                )
            )
            preload(additional_bytes, app_data, inner_image_path)
    else:
        preload(additional_bytes, app_data)


def get_device_type_and_preloaded_builds():
    return {
        "device_type": get_device_type_slug(),
        "preloaded_builds": list_images(),
    }


PARTITIONS_CACHE[None] = prepare_global_partitions()


def get_partition(name, image=None):
    partitions = PARTITIONS_CACHE.get(image)
    if partitions is None:
        partitions = get_partitions(image)
        PARTITIONS_CACHE[image] = partitions
    # In resinOS 1.8 the root partition is named "resin-root"
    if name == "resin-rootA":
        names = ["resin-rootA", "resin-root"]
    elif name == "flash-rootA":
        names = ["flash-rootA", "flash-root"]
    else:
        names = [name]
    for name in names:
        part = partitions.get(name)
        if part is not None:
            return part


methods = {
    "get_device_type_and_preloaded_builds": (
        get_device_type_and_preloaded_builds
    ),
    "preload": main_preload,
}


if __name__ == "__main__":
    for line in sys.stdin:
        data = json.loads(line)
        method = methods[data["command"]]
        result = method(**data.get("parameters", {}))
        print(json.dumps({"result": result}))
