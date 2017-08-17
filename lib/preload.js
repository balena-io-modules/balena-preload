'use strict'

const _ = require('lodash')
const path = require('path')
const streamModule = require('stream')
const Promise = require('bluebird')
const tar = Promise.promisifyAll(require('tar-stream'))
const fs = Promise.promisifyAll(require('fs'))
const errors = require('resin-errors')
const request = require('request-promise')

const preload = module.exports

const CONCURRENT_REQUESTS_TO_REGISTRY = 10
const DOCKER_IMAGE_TAG = 'resin/resin-preload'
const DISK_IMAGE_PATH_IN_DOCKER = '/img/resin.img'
const SPLASH_IMAGE_PATH_IN_DOCKER = '/img/resin-logo.png'
const CTRL_C = 3

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
  let fullPath
  const pack = tar.pack()
  return Promise.map(filenames, (filePath) => {
    fullPath = path.join(dir, filePath)
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
  return docker.createContainer({
    Image: DOCKER_IMAGE_TAG,
    Name: preload.CONTAINER_NAME,
    NetworkMode: 'host',
    Privileged: true,
    AttachStdout: true,
    AttachStderr: true,
    Env: [
      `COMMAND=${options.command}`,
      `APP_DATA=${JSON.stringify(options.appData)}`,
      `CONTAINER_SIZE=${options.containerSize || ''}`,
      `REGISTRY_HOST=${options.registryHost || ''}`,
      `DONT_DETECT_FLASHER_TYPE_IMAGES=${options.dontDetectFlasherTypeImages ? 'TRUE' : 'FALSE'}`,
      `HTTP_PROXY=${options.proxy || ''}`,
      `HTTPS_PROXY=${options.proxy || ''}`
    ],
    Mounts: mounts
  })
}

const createContainerDisposer = (docker, options) => {
  return createContainer(docker, options)
  .disposer((container) => {
    return container.remove()
  })
}

const runContainer = (docker, container) => {
  // We want to remove the container after it runs.
  // We also want CTRL-C to kill the container and remove it.
  const killContainer = (data) => {  // data is from stdin
    if (data[0] !== CTRL_C) {
      return
    }
    container.kill()
  }
  const removeListener = () => {
    // Set things back to normal.
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdin.removeListener('data', killContainer)
    }
  }
  // Set raw mode to be able to intercept CTRL-C
  if (process.stdin.setRawMode) {
    process.stdin.resume()
    process.stdin.setRawMode(true)
    process.stdin.on('data', killContainer)
  }

  const stdout = new streamModule.PassThrough()
  const stderr = new streamModule.PassThrough()
  return container.start()
  .then((container) => {
    const statusCodePromise = container.wait()
    .then((info) => {
      removeListener()
      return container.remove()
      .return(info.StatusCode)
    })
    return container.attach({stream: true, stdout: true, stderr: true})
    .then((stream) => {
      docker.modem.demuxStream(stream, stdout, stderr)
      return { statusCodePromise, stdout, stderr }
    })
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

const getContainerSize = (apiHost, apiToken, registryHost, imageRepo) => {
  console.log('Fetching container size for', imageRepo)
  return getRegistryToken(apiHost, apiToken, registryHost, imageRepo)
  .then((token) => {
    return registry(registryHost, `v2/${imageRepo}/manifests/latest`, token, {}, true, true)
    .then((response) => {
      const layersCount = _.countBy(_.map(response.body.fsLayers, 'blobSum'))
      return Promise.map(
        _.entries(layersCount),
        (layer) => {
          return getLayerSize(registryHost, token, imageRepo, layer[0])
          .then((layerSize) => {
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
 * @returns {Stream}
 */
preload.build = (docker) => {
  const stream = new streamModule.PassThrough()
  const files = ['Dockerfile', 'requirements.txt', 'src/preload.py']

  tarFiles(path.resolve(__dirname, '..'), files)
  .then((tarStream) => {
    return docker.buildImage(tarStream, {t: DOCKER_IMAGE_TAG})
  })
  .then((build) => {
    docker.modem.followProgress(
      build,
      (error, output) => {  // onFinished
        if (error) {
          stream.emit(error)
        } else {
          stream.end()
        }
      },
      (event) => {  // onProgress
        if (event.stream) {
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

 * @returns {Promise<Object>} - { Promise<Number> statusCodePromise, Stream stdout, Stream stderr }
 */
preload.run = (resin, docker, options) => {
  options.apiHost = resin.pine.API_URL
  options.registryHost = options.registryHost || 'registry2.resin.io'
  options.imageRepo = getImageRepo(options.application, options.commit)
  options.appData = getAppData(options.registryHost, options.application, options.commit)
  options.command = 'preload'

  return checkImage(options.image)
  .then(() => {
    return resin.auth.getToken()
  })
  .then((token) => {
    options.apiToken = token
    return getContainerSize(options.apiHost, options.apiToken, options.registryHost, options.imageRepo)
  })
  .then((containerSize) => {
    options.containerSize = containerSize
    return createContainer(docker, options)
  })
  .then((container) => {
    return runContainer(docker, container)
  })
}

/**
 * Get the deviceType of an image
 * @param {Object} options - Image options
 * @param {String} options.image - Path to image to preload
 * @returns {Object} - { String slug, Array<String> builds }
 */
preload.getDeviceTypeSlugAndPreloadedBuilds = (docker, options) => {
  return checkImage(options.image)
  .then(() => {
    options.command = 'get_device_type_slug_and_preloaded_builds'
    return Promise.using(createContainerDisposer(docker, options), (container) => {
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
          if (info.StatusCode !== 0) {
            throw new Error(err.getData().toString('utf8').trim())
          }
          return JSON.parse(out.getData().toString('utf8'))
        })
      })
    })
  })
}
