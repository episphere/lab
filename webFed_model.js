const frameworks = {
  'tfjs': {
    "name": "TensorFlow.js",
    "moduleURL": "https://esm.sh/@tensorflow/tfjs"
  },
  'onnx': {
    "name": "ONNX",
    "moduleURL": "https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/esm/ort.min.js",
    "extraDependencies": {
      "env": {
        "wasm": {
          "wasmPaths": "https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/"
        }
      }
    }
  }
}

class TFJSModel {
  constructor({ inputShape, architecture, activation, bias, outputActivation, optimizer, lossFunc, metrics, batchSize }) {
    this.inputShape = inputShape
    this.architecture = architecture
    this.activation = activation
    this.bias = bias
    this.outputActivation = outputActivation
    this.optimizer = optimizer
    this.lossFunc = lossFunc
    this.metrics = metrics
    this.batchSize = batchSize

    this.model = undefined
  }

  async build(options = {}) {
    const tf = await import(frameworks['tfjs'].moduleURL)
    

    this.model = await new Promise(resolve => {

      tf.tidy(() => {
        const layers = this.architecture.map((layer, index) => {
          let layerArch = {
            'type': layer?.type || "dense",
            'units': layer?.units || (Number.isInteger(layer) ? layer : undefined),
            'kernelSize': layer?.kernelSize,
            'filters': layer?.filters,
            'poolSize': layer?.poolSize,
            'strides': layer?.strides,
            'activation': layer?.activation || this.activation,
            'bias': layer?.bias || this.bias
          }

          if (index === 0) {
            layerArch.inputShape = this.inputShape
          } else if (index === this.architecture.length - 1) {
            layerArch.activation = this.outputActivation
          }
          return tf.layers[layerArch.type](layerArch)
        })

        const model = tf.sequential({
          layers
        })
        resolve(model)
      })

    })
  }

  topology() {
    return this.model.summary()
  }

  async getWeights(layerIdentifier) {
    if (layerIdentifier) {
      const layerWeight = this.model.getLayer(layerIdentifier).getWeights(true).data().flat()
      return layerWeight
    } else {
      const weights = this.model.getWeights().map(weightsMat => {
        return Object.values(weightsMat.dataSync())
      })
      return weights
    }
  }

  async setWeights(weights, layerIdentifier) {
    // Expects weights to be array of tensors of length equal to the number of layers in the model.
    if (layerIdentifier) {
      const layer = this.model.getLayer(layerIdentifier)
      if (Array.isArray(weights) && typeof(weights[0]?.shape) === 'undefined') {
        const tf = await import(frameworks['tfjs'].moduleURL)
        const currentWeights = layer.getWeights()
        weights = weights.map((w, i) => {
          w = tf.tensor(w, currentWeights[i].shape, currentWeights[i].dtype)
          return w
        })
      }
      layer.setWeights(weights)
    } else {
      if (Array.isArray(weights) && typeof(weights[0]?.shape) === 'undefined') {
        const tf = await import(frameworks['tfjs'].moduleURL)
        const currentWeights = this.model.getWeights()
        weights = weights.map((w, i) => {
          w = tf.tensor(w, currentWeights[i].shape, currentWeights[i].dtype)
          return w
        })
      }
      this.model.setWeights(weights)
    }
  }

  async train(trainingData, trainingLabels, initialEpoch, numEpochsToTrainFor, args) {
    if (!this.model) {
      await this.build()
    }
    this.model.compile({
      'loss': this.lossFunc,
      'optimizer': this.optimizer,
      'metrics': this.metrics
    })
    
    const gradientUpdate = await this.model.fit(trainingData, trainingLabels, {
      'batchSize': this.batchSize,
      'initialEpoch': initialEpoch,
      'epochs': initialEpoch+numEpochsToTrainFor,
      ...args
    })
    return gradientUpdate
  }

}

class ONNXModel {
  constructor({ inputShape = 2, architecture = [], activation = "relu", bias = false, outputActivation = "softmax", optimizer = "sgd", lossFunc, metrics = [], numEpochs = 1, batchSize = 1, callbacks = [] }) {
    this.inputShape = inputShape
    this.architecture = architecture
    this.activation = activation
    this.bias = bias
    this.outputActivation = outputActivation
    this.optimizer = optimizer
    this.lossFunc = lossFunc
    this.metrics = metrics
    this.numEpochs = numEpochs
    this.batchSize = batchSize
    this.callbacks = callbacks

    this.model = undefined
  }

  async buildModel(options = {}) {

  }
}

export class FedModel {
  constructor({ framework = "tfjs", inputShape, architecture = [], activation = "relu", bias = false, outputActivation = "softmax", optimizer = "sgd", lossFunc, metrics = [], batchSize = 4, endpoints = {} }) {
    this.framework = framework
    this.inputShape = inputShape
    this.architecture = architecture
    this.activation = activation
    this.bias = bias
    this.outputActivation = outputActivation
    this.optimizer = optimizer
    this.lossFunc = lossFunc
    this.metrics = metrics
    this.batchSize = batchSize
    this.endpoints = {}

    this.modelInstance = undefined
  }

  async build(options = {}) {
    if (typeof (this.modelInstance) !== 'undefined') {
      return this.modelInstance
    }

    if (typeof (frameworks[this.framework]) === 'undefined' || this.architecture.length === 0) {
      console.error(`Model cannot be built, incorrect or missing required parameters:\n
        Framework: ${this.framework}\n
        Input Shape: ${this.inputShape}\n
        Architecture: ${this.architecture}`)
      return undefined
    }

    if (this.framework === 'tfjs') {
      this.modelInstance = new TFJSModel(this)
    }
    else if (this.framework === 'onnx') {
      // this.modelInstance = new OnnxModel({})
    }
    await this.modelInstance.build(options)
    return this.modelInstance
  }

  getTopology() {
    // if (this.framework === 'tfjs') {
    // }
    return this.modelInstance.topology()
  }

  async getWeights(layerIdentifier) {
    // if (this.framework === 'tfjs') {
    // }
    return await this.modelInstance.getWeights(layerIdentifier)
  }

  setWeights(weights, layerIdentifier) {
    this.modelInstance.setWeights(weights, layerIdentifier)
  }

  fit(trainingData, trainingLabels, initialEpoch = 0, numEpochsToTrainFor = 5) {
    if (typeof (this.lossFunc) === 'undefined' || typeof (this.batchSize) === 'undefined') {
      console.error(`Cannot start model training, incorrect or missing required parameters:\n
        Loss function: ${this.lossFunc}\n,
        Batch Size: ${this.batchSize}`)
      return
    }
    if (!this.modelInstance) {
      this.build()
    }
    return this.modelInstance.train(trainingData, trainingLabels, initialEpoch, numEpochsToTrainFor)
  }

  async destroyModel() {
    this.modelInstance?.dispose()
    this.modelInstance = undefined
  }

}