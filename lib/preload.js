'use strict'

const _ = require('lodash')
const dockerProgress = require('docker-progress')
const path = require('path')
const streamModule = require('stream')
const Promise = require('bluebird')
const tar = Promise.promisifyAll(require('tar-stream'))
const fs = Promise.promisifyAll(require('fs'))
const errors = require('resin-errors')
const request = require('request-promise')
const getPort = require('get-port')
const os = require('os')
const EventEmitter = require('events')

const preload = module.exports

const CONCURRENT_REQUESTS_TO_REGISTRY = 10
const DOCKER_IMAGE_TAG = 'resin/resin-preload'
const DISK_IMAGE_PATH_IN_DOCKER = '/img/resin.img'
const SPLASH_IMAGE_PATH_IN_DOCKER = '/img/resin-logo.png'
const DOCKER_STEP_RE = /Step (\d+)\/(\d+)/

const GRAPHDRIVER_ERROR = 'Error starting daemon: error initializing graphdriver: driver not supported'
const OVERLAY_MODULE_MESSAGE = 'You need to load the "overlay" module to be able to preload this image: run "sudo modprobe overlay".'
const DOCKERD_USES_OVERLAY = '--storage-driver=overlay2'

const CTRL_C = 3

exports.CtrlCInterceptor = class CtrlCInterceptor {
  constructor (action, stdin) {
    if (!stdin) {
      stdin = process.stdin
    }
    this.action = action
    this.stdin = stdin
    this.actionned = false
    const self = this
    this.listener = (data) => {
      if (!self.actionned) {
        self.actionned = true
        if (data[0] === CTRL_C) {
          self.action()
        }
      }
    }
  }

  start () {
    if (this.stdin.setRawMode) {
      this.stdin.resume()
      this.stdin.setRawMode(true)
      this.stdin.on('data', this.listener)
    }
  }

  stop () {
    if (this.stdin.setRawMode) {
      this.stdin.setRawMode(false)
      this.stdin.pause()
      this.stdin.removeListener('data', this.listener)
    }
  }
}

class BufferBackedWritableStream extends streamModule.Writable {
  constructor () {
    super(arguments)
    this.chunks = []
  }

  _write (chunk, enc, next) {
    this.chunks.push(chunk)
    next()
  }

  getData () {
    return Buffer.concat(this.chunks)
  }
}

const tarFiles = (dir, filenames) => {
  const pack = tar.pack()
  return Promise.map(filenames, (filePath) => {
    const fullPath = path.join(dir, filePath)
    return Promise.join(fs.statAsync(fullPath), fs.readFileAsync(fullPath), (stats, data) => {
      return pack.entryAsync({ name: filePath, size: stats.size, mode: stats.mode }, data)
    })
  })
  .then(() => {
    pack.finalize()
    return pack
  })
}

const bindMount = (source, target) => {
  return {
    Source: path.resolve(source),
    Target: target,
    Type: 'bind',
    Consistency: 'delegated'
  }
}

const createContainer = (docker, options) => {
  const mounts = [bindMount(options.image, DISK_IMAGE_PATH_IN_DOCKER)]
  if (options.splashImage) {
    mounts.push(bindMount(options.splashImage, SPLASH_IMAGE_PATH_IN_DOCKER))
  }
  const containerOptions = {
    Image: DOCKER_IMAGE_TAG,
    Name: preload.CONTAINER_NAME,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: true,
    Env: [
      `COMMAND=${options.command}`,
      `APP_DATA=${JSON.stringify(options.appData)}`,
      `CONTAINER_SIZE=${options.containerSize || ''}`,
      `REGISTRY_HOST=${options.registryHost || ''}`,
      `DONT_DETECT_FLASHER_TYPE_IMAGES=${options.dontDetectFlasherTypeImages ? 'TRUE' : 'FALSE'}`,
      `HTTP_PROXY=${options.proxy || ''}`,
      `HTTPS_PROXY=${options.proxy || ''}`,
      `DOCKER_PORT=${options.dockerPort || ''}`
    ],
    HostConfig: {
      Privileged: true,
      Mounts: mounts
    }
  }
  if (os.platform() === 'linux') {
    containerOptions.HostConfig.NetworkMode = 'host'
  } else {
    if (options.dockerPort) {
      containerOptions.ExposedPorts = {}
      containerOptions.ExposedPorts[`${options.dockerPort}/tcp`] = {}
      containerOptions.HostConfig.PortBindings = {}
      containerOptions.HostConfig.PortBindings[`${options.dockerPort}/tcp`] = [{
        HostPort: `${options.dockerPort}`,
        HostIp: ''
      }]
    }
    containerOptions.HostConfig.NetworkMode = 'bridge'
  }
  return docker.createContainer(containerOptions)
}

const createContainerDisposer = (docker, options) => {
  return createContainer(docker, options)
  .disposer((container) => {
    return container.remove()
  })
}

/**
 * @description
 * preload.py is running inside the outer Docker container.
 * We wait until it outputs something on stdout, that means that the inner
 * Docker is ready.
 * Then we pull the build and signal the Python script that we're done by
 * writing on its stdin.
 *
 * @param {Stream} stdout - Python script's stdout
 * @param {Stream} stdin - Python script's stdin
 * @param {Number} dockerPort - The port on which the inner dockerd is listening
 * @param {String} imageId - The image to pull
 * @param {EventEmitter} dockerPullProgress - an event emitter used to report pull progress
 */
const pullBuild = (stdout, stdin, dockerPort, imageId, dockerPullProgress) => {
  stdout.on('data', (data) => {
    const innerDockerProgress = new dockerProgress.DockerProgress({
      Promise,
      host: '0.0.0.0',
      port: dockerPort
    })
    innerDockerProgress.pull(imageId, (event) => {
      dockerPullProgress.emit('progress', event.percentage)
    })
    .then(() => {
      // Signal that we're done to the Python script.
      stdin.write('\n')
    })
  })
}

const runPreloadContainerAndPull = (docker, container, imageId, dockerPort, output, dockerPullProgress, canceller) => {
  canceller.on('cancel', container.kill.bind(container))
  const stdout = new streamModule.PassThrough()
  return container.start()
  .then((container) => {
    return container.attach({ stream: true, stdout: true, stderr: true, stdin: true })
  })
  .then((stream) => {
    docker.modem.demuxStream(stream, stdout, output)
    pullBuild(stdout, stream, dockerPort, imageId, dockerPullProgress)
    return container.wait()
  })
  .then((info) => {
    return info.StatusCode
  })
}

const isReadWriteAccessibleFile = (image) => {
  return Promise.all([
    fs.accessAsync(image, fs.constants.R_OK | fs.constants.W_OK),
    fs.statAsync(image)
  ])
  .spread((_, stats) => {
    return stats.isFile()
  })
  .catchReturn(false)
}

const checkImage = (image) => {
  return isReadWriteAccessibleFile(image)
  .then((ok) => {
    if (!ok) {
      throw new errors.ResinError('The image must be a read / write accessible file')
    }
  })
}

const registry = (registryHost, endpoint, registryToken, headers, decodeJson, followRedirect) => {
  headers = Object.assign({}, headers)
  headers['Authorization'] = `Bearer ${registryToken}`
  return request({
    uri: `https://${registryHost}/${endpoint}`,
    headers: headers,
    json: decodeJson,
    simple: false,
    resolveWithFullResponse: true,
    followRedirect
  })
}

const api = (apiHost, apiToken, endpoint, params, headers) => {
  const url = `${apiHost}/${endpoint}`
  params = Object.assign({}, params)
  headers = Object.assign({}, headers)
  headers['Authorization'] = `Bearer ${apiToken}`
  return request({uri: url, qs: params, headers: headers, json: true})
}

const getRegistryToken = (apiHost, apiToken, registryHost, imageRepo) => {
  const params = {
    service: registryHost,
    scope: `repository:${imageRepo}:pull`
  }
  return api(apiHost, apiToken, 'auth/v1/token', params)
  .then((data) => {
    return data['token']
  })
}

const getLayerSize = (registryHost, token, imageRepo, blobSum) => {
  // the last 4 bytes of each gzipped layer are the layer size % 32
  const headers = {Range: 'bytes=-4'}
  return registry(registryHost, `v2/${imageRepo}/blobs/${blobSum}`, token, {}, false, false)
  .then((response) => {
    return request({uri: response.headers.location, headers, encoding: null})
  })
  .then((buffer) => {
    return buffer.readUIntLE(0, 4)
  })
}

/**
 * Returns a Promise of the container size in bytes

 * @param {Object} options - Image options
 * @param {Object} options.apiHost
 * @param {String} options.apiToken
 * @param {String} options.registryHost
 * @param {String} options.imageRepo
 * @param {String} options.fetchSizeProgress

 * @returns {Promise<Number>} - container size
 */
const getContainerSize = (options) => {
  options.fetchSizeProgress.emit('progress', 0)
  return getRegistryToken(options.apiHost, options.apiToken, options.registryHost, options.imageRepo)
  .then((token) => {
    return registry(options.registryHost, `v2/${options.imageRepo}/manifests/latest`, token, {}, true, true)
    .then((response) => {
      const layersCount = _.countBy(_.map(response.body.fsLayers, 'blobSum'))
      const size = _.size(layersCount) + 1
      let finished = 0
      const updateProgress = () => {
        finished += 1
        options.fetchSizeProgress.emit('progress', finished / size * 100)
      }
      updateProgress()
      return Promise.map(
        _.entries(layersCount),
        (layer) => {
          return getLayerSize(options.registryHost, token, options.imageRepo, layer[0])
          .then((layerSize) => {
            updateProgress()
            return layerSize * layer[1]
          })
        },
        {concurrency: CONCURRENT_REQUESTS_TO_REGISTRY}
      )
    })
  })
  .reduce((a, b) => a + b)
}

const getAppData = (registryHost, application, commit) => {
  // Extracts application metadata
  const env = {}
  const config = {}
  application.environment_variable.forEach((envvar) => {
    if (envvar.name.startsWith('RESIN_')) {
      config[envvar.name] = envvar.value
    } else {
      env[envvar.name] = envvar.value
    }
  })
  return {
    appId: application.id,
    name: application.app_name,
    commit: commit || application.commit,
    // NOTE: This replaces the registry host in the `imageId` to stop the newer
    // supervisors from re-downloading the app on first boot
    imageId: `${registryHost}/${getImageRepo(application, commit)}`,
    env,
    config
  }
}

const getImageRepo = (application, commit) => {
  return `${application.app_name}/${commit || application.commit}`.toLowerCase()
}

preload.errors = errors

/** @const {String} Container name */
preload.CONTAINER_NAME = 'resin-image-preloader'

/**
 * Build the preloader docker image
 * @param {Object} docker - dockerode instance
 * @returns {Stream} - The build output stream that also emits 'progress' events with the completion percentage
 */
preload.build = (docker) => {
  const stream = new streamModule.PassThrough()
  const files = ['Dockerfile', 'requirements.txt', path.join('src', 'preload.py')]
  stream.emit('progress', 0)

  tarFiles(path.resolve(__dirname, '..'), files)
  .then((tarStream) => {
    return docker.buildImage(tarStream, {t: DOCKER_IMAGE_TAG})
  })
  .then((build) => {
    docker.modem.followProgress(
      build,
      (error, output) => {  // onFinished
        if (error) {
          stream.emit('error', error)
        } else {
          stream.emit('progress', 100)
          stream.end()
        }
      },
      (event) => {  // onProgress
        if (event.stream) {
          const matches = event.stream.match(DOCKER_STEP_RE)
          if (matches) {
            stream.emit('progress', parseInt(matches[1]) / (parseInt(matches[2]) + 1) * 100)
          }
          stream.write(event.stream)
        }
      }
    )
  })

  return stream
}

const applicationExpandOptions = preload.applicationExpandOptions = {
  environment_variable: {
    $select: ['name', 'value']
  },
  build: {
    $select: ['id', 'commit_hash', 'push_timestamp'],
    $orderby: 'push_timestamp desc',
    $filter: {
      status: 'success'
    }
  }
}

preload.BUILD_HASH_LENGTH = 40

preload.getApplication = (resin, appId) => {
  return resin.models.application.get(appId, {expand: applicationExpandOptions})
}

/**
 * Preload a given image
 * @param {Stream} [stdin] - A stream on which we listen for CTRL+C for interrupting the preload.

 * @param {Object} resin - Configured resin-sdk object

 * @param {Object} docker - Configured dockerode object

 * @param {Object} options - Image options
 * @param {Object} options.application - Application
 * @param {String} options.image - Path to image to preload
 * @param {String} [options.commit] - Application commit to preload
 * @param {String} [options.dontDetectFlasherTypeImages] - Disables the flasher type images detection: treats all images as non flasher types

 * @param {String} [options.registry] - Docker registry host

 * @param {String} [options.docker] - Path to a local docker socket
 * @param {String} [options.dockerHost] - The address of the host containing the docker daemon
 * @param {String} [options.dockerPort] - The port on which the host docker daemon is listening
 * @param {String} [options.ca] - Docker host TLS certificate authority file
 * @param {String} [options.cert] - Docker host TLS certificate file
 * @param {String} [options.key] - Docker host TLS key file

 * @returns {Object} - { Promise<Number> statusCodePromise, Stream output, EventEmitter fetchSizeProgress, EventEmitter dockerPullProgress, Function cancel }
 */
preload.run = (stdin, resin, docker, options) => {
  options.apiHost = resin.pine.API_URL
  options.registryHost = options.registryHost || 'registry2.resin.io'
  options.imageRepo = getImageRepo(options.application, options.commit)
  options.appData = getAppData(options.registryHost, options.application, options.commit)
  options.command = 'preload'

  const output = new streamModule.PassThrough()
  const fetchSizeProgress = new EventEmitter()
  const dockerPullProgress = new EventEmitter()
  const canceller = new EventEmitter()
  const cancel = () => {
    canceller.emit('cancel')
  }

  const statusCodePromise = checkImage(options.image)
  .then(() => {
    return Promise.all([resin.auth.getToken(), getPort()])
  })
  .spread((token, port) => {
    options.apiToken = token
    options.dockerPort = port
    return getContainerSize({
      apiHost: options.apiHost,
      apiToken: options.apiToken,
      registryHost: options.registryHost,
      imageRepo: options.imageRepo,
      fetchSizeProgress
    })
  })
  .then((containerSize) => {
    options.containerSize = containerSize
    return Promise.using(createContainerDisposer(docker, options), (container) => {
      return runPreloadContainerAndPull(docker, container, options.appData.imageId, options.dockerPort, output, dockerPullProgress, canceller)
    })
  })

  return { statusCodePromise, output, fetchSizeProgress, dockerPullProgress, cancel }
}

/**
 * Get the deviceType of an image
 * @param {Object} docker - dockerode instance
 * @param {Object} options - Image options
 * @param {String} options.image - Path to image to preload
 * @returns {Object} - { Promise<{ String slug, Array<String> builds }> promise, Function cancel }
 */
preload.getDeviceTypeSlugAndPreloadedBuilds = (docker, options) => {
  let container
  let cancelled = false
  const cancel = () => {
    if (container) {
      cancelled = true
      container.kill()
    }
  }
  const promise = checkImage(options.image)
  .then(() => {
    options.command = 'get_device_type_slug_and_preloaded_builds'
    return Promise.using(createContainerDisposer(docker, options), (container_) => {
      container = container_
      return container.start()
      .then((container) => {
        return container.attach({stream: true, stdout: true, stderr: true})
      })
      .then((stream) => {
        const out = new BufferBackedWritableStream()
        const err = new BufferBackedWritableStream()
        docker.modem.demuxStream(stream, out, err)
        return container.wait()
        .then((info) => {
          if (cancelled) {
            return
          }
          if (info.StatusCode !== 0) {
            const output = err.getData().toString('utf8').trim()
            if ((output.indexOf(GRAPHDRIVER_ERROR) !== -1) && (output.indexOf(DOCKERD_USES_OVERLAY) !== -1)) {
              throw new errors.ResinError(OVERLAY_MODULE_MESSAGE)
            } else {
              throw new Error(output)
            }
          }
          return JSON.parse(out.getData().toString('utf8'))
        })
      })
    })
  })
  return { promise, cancel }
}
