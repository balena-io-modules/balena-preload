#!/usr/bin/python3 -u
import json
import os
import sys

from contextlib import contextmanager
from functools import partial
from logging import getLogger, INFO, StreamHandler
from math import ceil, floor
from re import search, sub
from sh import (
    btrfs,
    dd,
    docker,
    dockerd,
    e2fsck,  # TODO: remove
    file,
    fsck,
    losetup,
    lsblk,
    mknod,
    mount,
    parted,  # TODO: remove
    resize2fs,
    sfdisk,
    umount,
    ErrorReturnCode,
)
from shutil import copyfile, rmtree
from sys import exit
from tempfile import mkdtemp, NamedTemporaryFile

os.environ["LANG"] = "C"

MBR_SIZE = 512
SECTOR_SIZE = 512

#PARTITIONS = json.loads(os.environ["PARTITIONS"])

SPLASH_IMAGE_FROM = "/img/resin-logo.png"
SPLASH_IMAGE_TO = "/splash/resin-logo.png"

DOCKER_HOST = "tcp://0.0.0.0:{}".format(os.environ.get("DOCKER_PORT") or 8000)

log = getLogger(__name__)
log.setLevel(INFO)
log.addHandler(StreamHandler())

def get_partitions(image):
    table = PartitionTable(image)
    for p in table.partitions:  # TODO: remove
        log.info("partition {}: {}".format(p.number, p.label))
    return {
        p.label: {"number": p.number, "image": image}
        for p in table.partitions
    }

def prepare_global_partitions():
    partitions = os.environ.get("PARTITIONS")
    if partitions is not None:
        return json.loads(partitions)
    return get_partitions("/img/resin.img")


def get_labels_from_devices(devices):
    # `lsblk` does not give the partition labels inside this container.
    # We workaround this by using `file -s`
    # Returns a dict of <partition number>: <partition label> for these devices
    result = {}
    for number, device in devices.items():
        if number is not None:
            out = file("-s", device).stdout.decode("utf8").strip()
            # "label:" is for fat partitions,
            # "volume name" is for ext partitions
            match = search(', (label:|volume name) "(.*)"', out)
            if match is not None:
                result[number] = match.groups()[1].strip()
    return result


def get_labels_from_image(image):
    with new_losetup_context_manager(image) as devices:
        return get_labels_from_devices(devices)


class Partition(object):
    def __init__(
        self,
        partition_table,
        number,
        label=None,
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
        # label returned by lsblk, not part of the sfdisk script
        self.label = label
        self.node = node
        self.start = start
        self.size = size
        self.type = type
        self.uuid = uuid
        self.name = name
        self.bootable = bootable

    def set_parent(self, parent):
        # For logical partitions on MBR disks we store the parent extended
        # partition
        assert self.partition_table.label == "dos"
        self.parent = parent

    @property
    def end(self):
        # last byte (included)
        return self.start + self.size - 1

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
        # use lsblk to get partition labels (they are not returned by sfdisk on
        # MBR disks)
        labels = get_labels_from_image(image)
        self.partitions = []
        extended_partition = None
        for number, partition_data in enumerate(data["partitions"], 1):
            partition_data["label"] = labels.get(number)
            part = Partition(self, number, **partition_data)
            if part.is_extended():
                extended_partition = part
            if extended_partition and part.is_included_in(extended_partition):
                part.set_parent(extended_partition)
            self.partitions.append(part)

    def get(self, label_or_number):
        if type(label_or_number) == int:
            return self.get_by_number(label_or_number)
        elif type(label_or_number) == str:
            return self.get_by_label(label_or_number)

    def get_by_number(self, number):
        return self.partitions[number - 1]

    def get_by_label(self, label):
        if self.label == "gpt":
            for part in self.partitions:
                if partition.label == label:
                    return partition

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

#def get_partition_table(image):
#      result = {"partitions": []}
#      lines = sfdisk("--dump", image).stdout.decode("utf8").strip().split("\n")
#      label = lines[0][7:]
#      assert label in ("dos", "gpt")
#      result["label"] = label
#      partition_lines = lines[lines.index("") + 1:]
#      for number, line in enumerate(partition_lines, 1):
#          line = line.replace(" ", "").split(":", 1)[1]  # remove filename
#          data = dict(pair.split("=") for pair in line.split(","))
#          data["number"] = number
#          data["image"] = image
#          for k in ("start", "size"):  # convert sectors to bytes
#              data[k] = int(data[k]) * SECTOR_SIZE
#          name = data.get("name")
#          if name:
#              name = name[1:-1]  # remove double quotes around the name
#          elif label == "dos":
#              name = RESIN_MBR_PARTITION_NAMES.get(number)
#          else:
#              assert False, "No partition names on a gpt image."
#          data["name"] = name
#          result["partitions"].append(data)
#      return result


def resize_partition(image, number, additional_bytes): # TODO: split
    # This function expects the partitions to be in disk order: it will fail if
    # there are primary partitions after an extended one containing logical
    # partitions.
    # Get the partition
    partition_table = PartitionTable(image)
    partition = partition_table.get(number)
    # Is it the last partition on the disk?
    if partition.is_last():
        # This is the simple case: expand the partition and its parent extended
        # partition if it is a logical one.
        # Expand image size
        expand_file(image, additional_bytes)
        if partition.parent is not None:
            # Resize the extended partition
            sfdisk("-n", partition.parent.number, image, _in=", +")
        # Resize the partition itself
        sfdisk("-n", partition.number, image, _in=", +")
    else:
        # Resizing logical partitions that are not the last on the disk is not
        # implemented
        assert partition.parent is None
        # Create a new temporary file of the correct size
        tmp = NamedTemporaryFile(dir=os.path.dirname(image), delete=False)
        tmp.truncate(file_size(image) + additional_bytes)
        tmp.close()
        # Update the partition table
        additional_sectors = additional_bytes / SECTOR_SIZE
        # resize the partition
        partition.size += additional_sectors
        # move the partitions after
        for part in partition_table.partitions[number:]:
            part.start += additional_sectors
        if partition_table.lastlba is not None:
            partition_table.lastlba += additional_sectors
        sfdisk(tmp.name, _in=partition_table.get_sfdisk_script())
        # Now we copy the data from the image to the temporary file
        copy = partial(  # TODO: bs
            ddd,
            _if=image,
            of=tmp.name,
            bs=SECTOR_SIZE,
            conv="notrunc",
        )
        # Copy partitions before and the partition itself
        for part in partition_table.partitions[:number]:
            # No need to copy extended partitions, we'll copy their logical
            # partitions
            if not part.is_extended():
                copy(skip=part.start, seek=part.start, count=part.size)
        # Copy partitions after.
        for part in partition_table.partitions[number:]:
            if not part.is_extended():
                copy(
                    skip=part.start,
                    seek=part.start + additional_sectors,
                    count=part.size,
                )
        # Expand the filesystem.
        expand_filesystem(image, number)
        # Replace the original image contents.
        ddd(_if=tmp.name, of=image, bs=SECTOR_SIZE)


def get_filesystem(device):
    line = fsck("-N", device).stdout.decode("utf8").strip().split("\n")[1]
    return line.rsplit(" ", 2)[-2].split(".")[1]


@contextmanager
def new_mount_context_manager(device):  # TODO: remove old
    mountpoint = mkdtemp()
    mount(device, mountpoint)
    yield mountpoint
    umount(mountpoint)
    os.rmdir(mountpoint)


@contextmanager
def new_losetup_context_manager(image):  # TODO: remove old
    # `losetup` does not create the partition devices inside a container, we
    # need to create them manually with `mknod`
    result = {}
    device = losetup("-f", "--show", "-P", image).stdout.decode("utf8").strip()
    result[None] = device
    out = lsblk("-J", device).stdout.decode("utf8")
    data = json.loads(out)
    created_devices = []
    parts = data["blockdevices"][0]["children"]
    for part in parts:
        major, minor = part["maj:min"].split(":")
        dev = os.path.join("/dev", part["name"])
        mknod(dev, "b", major, minor)
        number = int(part["name"].rsplit("p", 1)[-1])
        result[number] = dev
        created_devices.append(dev)
    yield result
    for dev in created_devices:
        os.remove(dev)
    losetup("-d", device)


def expand_filesystem(image, number=None):
    # Detects the partition filesystem (ext{2,3,4} or btrfs) and uses the
    # appropriate tool to expand the filesystem to all the available space.
    with new_losetup_context_manager(image) as devices:
        device = devices[number]
        log.info("Using {}".format(device))
        fs = get_filesystem(device)
        log.info("Resizing {} filesystem".format(fs))
        if fs.startswith("ext"):
            try:
                status = fsck("-p", "-f", device, _ok_code=[0, 1, 2])
                if status.exit_code == 0:
                    log.info("File system OK")
                else:
                    log.warning("File system errors corrected")
            except ErrorReturnCode:
                raise Exception("File system errors could not be corrected")
            resize2fs("-f", loop_device)
        elif fs == "btrfs":
            with new_mount_context_manager(device) as mountpoint:
                btrfs("filesystem", "resize", "max", mountpoint)


def human_size(size, precision=2):
    suffixes = ['', 'Ki', 'Mi', 'Gi', 'Ti']
    idx = 0
    while idx < 4 and size >= 1024:
        idx += 1
        size /= 1024
    result = "{:.{}f}".format(size, precision).rstrip("0").rstrip(".")
    return "{} {}B".format(result, suffixes[idx])


def get_offsets_and_sizes(image, unit="B"):  # TODO: remove
    result = []
    output = parted("-s", "-m", image, "unit", unit, "p").stdout.decode("utf8")
    lines = output.strip().split("\n")
    for line in lines:
        if line[0].isdigit():
            data = line.split(":")
            offset = int(data[1][:-1])
            size = int(data[3][:-1])
            result.append((offset, size))
    return result


def get_offset_and_size(part):  # TODO: remove
    number = part.get("number")
    if number is None:
        # partition image: no need to read the partition table
        return 0, file_size(part["image"])
    else:
        # disk image
        return get_offsets_and_sizes(part["image"])[part["number"] - 1]


def mount_partition(partition_name, extra_options, image):  # TODO: remove
    part = get_partition(partition_name, image)
    offset, size = get_offset_and_size(part)
    mountpoint = mkdtemp()
    options = "offset={},sizelimit={}".format(offset, size)
    if extra_options:
        options += "," + extra_options
    mount("-o", options, part["image"], mountpoint)
    return mountpoint


@contextmanager
def mount_context_manager(partition_name, extra_options="", image=None):  # TODO: remove
    mountpoint = mount_partition(partition_name, extra_options, image)
    yield mountpoint
    umount(mountpoint)
    os.rmdir(mountpoint)


def losetup_partition(partition_name, image=None):  # TODO: remove
    part = get_partition(partition_name, image)
    offset, size = get_offset_and_size(part)
    return losetup(
        "-o",
        offset,
        "--sizelimit",
        size,
        "-P",
        "--show",
        "-f",
        part["image"],
    ).stdout.decode("utf8").strip()


@contextmanager
def losetup_context_manager(partition_name, image=None):  # TODO: remove
    device = losetup_partition(partition_name, image=image)
    yield device
    losetup("-d", device)


def expand_file(path, additional_bytes):
    with open(path, "a") as f:
        size = f.tell()
        f.truncate(size + additional_bytes)


def expand_ext4(partition_name, image=None):  # TODO: remove
    # Resize ext4 filesystem
    error = False
    with losetup_context_manager(partition_name, image=image) as loop_device:
        log.info("Using {}".format(loop_device))
        log.info("Resizing filesystem")
        try:
            status = e2fsck("-p", "-f", loop_device, _ok_code=[0, 1, 2])
            status = status.exit_code
            if status == 0:
                log.info("e2fsck: File system OK")
            else:
                log.warning("e2fsck: File system errors corrected")
        except ErrorReturnCode:
            log.error("e2fsck: File system errors could not be corrected")
            error = True
        resize2fs("-f", loop_device)
    if error:
        exit(1)


def expand_btrfs(mountpoint):  # TODO: remove
    btrfs("filesystem", "resize", "max", mountpoint)


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
        with mount_context_manager("boot", image=image) as mpoint:
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


def resize_fs_copy_splash_image_and_pull(app_data, image=None):
    driver = get_docker_storage_driver(image)
    extra_options = ""
    if driver != "btrfs":
        # For ext4, we'll have to keep it unmounted to resize
        log.info("Expanding ext filesystem")
        expand_ext4("data", image=image)
    else:
        extra_options = "nospace_cache,rw"
    with mount_context_manager("data", extra_options, image=image) as mpoint:
        if driver == "btrfs":
            # For btrfs we need to mount the fs for resizing.
            log.info("Expanding btrfs filesystem")
            expand_btrfs(mpoint)
        with docker_context_manager(driver, mpoint):
            write_apps_json(app_data, mpoint + "/apps.json")
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


def resize_rootfs_get_sfdisk_script(image, additional_sectors):  # TODO: remove
    """
    Helper for resize_rootfs: it gets the image sfdisk script, updates it
    by increasing the size of the 2nd partition and moving all partitions after
    it, and returns the resulting sfdisk script.
    """
    # Extract the image layout.
    layout = sfdisk(d=image).stdout.decode("utf8").strip()

    def add_size(match):
        # Helper for updating offset / size in a sfdisk script file line.
        groups = list(match.groups())
        groups[1] = str(int(groups[1]) + additional_sectors)
        return "".join(groups)

    lines = layout.split("\n")
    # Update 2nd partition size in the new layout.
    lines[6] = sub("(.*size=\s*)(\d+)(,.*)", add_size, lines[6])
    # Update the offsets of partitions 3+.
    for i in range(7, len(lines)):
        lines[i] = sub("(.*start=\s*)(\d+)(,.*)", add_size, lines[i])
    return "\n".join(lines)


def resize_rootfs(additional_bytes):  # TODO: remove
    log.info("Resizing the 2nd partition of the image.")
    part = get_partition("root")
    image = part["image"]
    size = file_size(image) + additional_bytes
    log.info("New disk image size: {}.".format(human_size(size)))
    additional_sectors = additional_bytes // SECTOR_SIZE
    # Create a new empty image of the required size
    tmp = NamedTemporaryFile(dir=os.path.dirname(image), delete=False)
    tmp.truncate(size)
    tmp.close()
    new_layout = resize_rootfs_get_sfdisk_script(image, additional_sectors)
    # Write the new layout on the new image.
    sfdisk(tmp.name, _in=new_layout)
    offsets_and_sizes = get_offsets_and_sizes(image, "s")
    copy = partial(ddd, _if=image, of=tmp.name, bs=SECTOR_SIZE, conv="notrunc")
    # Copy across any data that's located between the MBR and the first
    # partition (some devices rely on the bootloader being there, like the
    # Variscite DART-6UL)
    # We rely on the fact that MBR_SIZE == SECTOR_SIZE == 512 here
    # => mbr_size_in_sectors == 1
    mbr_size_in_sectors = MBR_SIZE // SECTOR_SIZE
    copy(
        skip=mbr_size_in_sectors,
        seek=mbr_size_in_sectors,
        count=offsets_and_sizes[0][0] - mbr_size_in_sectors,
    )
    # Copy partitions 1 and 2.
    for offset, size in offsets_and_sizes[:2]:
        copy(skip=offset, seek=offset, count=size)
    # Copy partitions 3+.
    for offset, size in offsets_and_sizes[2:]:
        copy(skip=offset, seek=offset + additional_sectors, count=size)
    # Expand 2nd partition.
    expand_ext4("root", image=tmp.name)
    # Replace the original image contents.
    ddd(_if=tmp.name, of=image, bs=SECTOR_SIZE)


def get_json(partition_name, path, image=None):
    with mount_context_manager(partition_name, image=image) as mountpoint:
        try:
            with open(os.path.join(mountpoint, path)) as f:
                return json.load(f)
        except FileNotFoundError:
            pass


def get_config(image=None):
    return (
        get_json("boot", "config.json", image=image) or  # resinOS 1.26+
        get_json("conf", "config.json", image=image)  # resinOS 1.8
    )


def get_device_type(image=None):
    return get_json("boot", "device-type.json", image=image)


def get_device_type_slug():
    device_type = get_device_type()
    if device_type is not None:
        return device_type["slug"]
    return get_config()["deviceType"]


def expand_data_partition(additional_bytes, image=None):  # TODO: remove
    part = get_partition("data", image)
    log.info("Expanding image size by {}".format(human_size(additional_bytes)))
    # Add zero bytes to image to be able to resize partitions
    expand_file(part["image"], additional_bytes)
    # do nothing if the data parition is in its own file
    if part["number"] != 0:
        # This code assumes that the data partition is the 6th and last one
        # and is contained in the 4th (extended) partition.
        assert part["number"] == 6
        log.info(
            "Expanding extended partition 4 and logical partition 6 to the "
            "end of the disk image."
        )
        parted(
            "-s",
            part["image"],
            "resizepart",
            4,
            "100%",
            "resizepart",
            part["number"],
            "100%",
        )


def preload(additional_bytes, app_data, image=None):
    replace_splash_image(image)
    expand_data_partition(additional_bytes, image)
    resize_fs_copy_splash_image_and_pull(app_data, image)


def get_inner_image_filename():
    device_type = get_device_type()
    if device_type:
        deployArtifact = device_type["yocto"]["deployArtifact"]
        if "-flasher-" in deployArtifact:
            return deployArtifact.replace("flasher-", "", 1)


def _list_images(image=None):
    driver = get_docker_storage_driver(image=image)
    with mount_context_manager("data", image=image) as mountpoint:
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


def list_images(detect_flasher_type_images):
    inner_image = get_inner_image_filename()
    if detect_flasher_type_images and inner_image:
        with mount_context_manager("root") as mountpoint:
            inner_image = os.path.join(mountpoint, "opt", inner_image)
            return _list_images(inner_image)
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
    # We're looking for a /docker/aufs/diff/<xxxxxxxxxxxxx>/ folder with some
    # files not starting with a '.'
    path = os.path.join(mountpoint, "docker", "aufs", "diff")
    return find_non_empty_folder_in_path(path)


def find_docker_overlay2_root(mountpoint):
    # We're looking for a /docker/overlay2/<xxxxxxxxxxxxx>/diff folder with
    # some files not starting with a '.'
    path = os.path.join(mountpoint, "docker", "overlay2")
    return find_non_empty_folder_in_path(path, "diff")


def get_docker_init_file_content(image=None):
    docker_service_file_path = "lib/systemd/system/docker.service"
    with mount_context_manager("root", image=image) as mountpoint:
        docker_root = find_docker_aufs_root(mountpoint)
        if docker_root is None:
            docker_root = find_docker_overlay2_root(mountpoint)
        if docker_root is not None:
            path = os.path.join(docker_root, docker_service_file_path)
        else:
            path = os.path.join(mountpoint, docker_service_file_path)
        with open(path) as f:
            return f.read()


def find_one_of(lst, *args):
    for elem in args:
        index = lst.index(elem)
        if index != -1:
            return index
    return -1


def get_docker_storage_driver(image=None):
    for line in get_docker_init_file_content(image).strip().split("\n"):
        if line.startswith("ExecStart="):
            words = line.split()
            position = find_one_of(words, "-s", "--storage-driver")
            if position != -1 and position < len(words) - 1:
                return words[position + 1]
    # Stop here if no driver was found
    assert False


def main_preload(app_data, container_size, detect_flasher_type_images):
    # Size will be increased by 110% of the container size
    additional_bytes = round_to_sector_size(ceil(int(container_size) * 1.1))
    inner_image = get_inner_image_filename()
    if not detect_flasher_type_images and inner_image:
        log.info(
            "Warning: This looks like a flasher type image but we're going to "
            "preload it like a regular image."
        )
    if detect_flasher_type_images and inner_image:
        part = get_partition("root")
        log.info(
            "This is a flasher image, preloading into /opt/{} on the 2nd "
            "partition of {}".format(inner_image, part["image"])
        )
        resize_rootfs(additional_bytes)
        with mount_context_manager("root") as mountpoint:
            image = os.path.join(mountpoint, "opt", inner_image)
            preload(additional_bytes, app_data, image)
    else:
        preload(additional_bytes, app_data)


def get_device_type_and_preloaded_builds(detect_flasher_type_images=True):
    return {
        "device_type": get_device_type_slug(),
        "preloaded_builds": list_images(detect_flasher_type_images),
    }


PARTITIONS = prepare_global_partitions()


def get_partition(name, image=None):  # TODO ?
    partitions = PARTITIONS if image is None else get_partitions(image)
    # Partition labels can be resin-<name> or flash-<name> for flasher images
    if name == "root":
        # In resinOS 1.8 the root partition is named "resin-root"
        names = ["resin-rootA", "resin-root", "flash-rootA", "flash-root"]
    else:
        names = ["resin-{}".format(name), "flash-{}".format(name)]
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
