// import * as tf from '@tensorflow/tfjs'
import webFed from "./webFed.js"

const iris = {}
iris.ui = {}
iris.mnistDB = {}
iris.mnist_NUM_CLASSES = 10
iris.stop = false

let GUN_SERVER = "http://localhost:8765/gun"

const indexedDBConfig = {
  dbName: "mnistDB",
  objectStoreOpts: {
    keyPath: "filename",
  },
  objectStoreIndex: {
    name: "filenameIdx",
    keyPath: "filename",
    objectParameters: {
      unique: true,
    },
  },
}
const filePickerEndpoint =
  "https://script.google.com/macros/s/AKfycbyS0oKEIPPN-qcp0RtX9VGFmu0rZ4MI8uMNm_OCPiwllXRBO_F4TTnEfOYavVzYTc3f/exec"
const manifests = {
  training: {
    filename: "trainingLabels.csv",
    count: 60000,
  },
  test: {
    filename: "testLabels.csv",
    count: 10000,
  },
}

const utils = {
  request: (url, opts, returnJson = true) =>
    fetch(url, opts).then((res) => {
      if (res.ok) {
        if (returnJson) return res.json()
        else return res
      } else {
        throw Error(res.status)
      }
    }),
}

const loadHashParams = () => {
  const hashParams = {}
  if (window.location.hash.includes("=")) {
    window.location.hash.slice(1).split('&').forEach(param => {
      let [key, value] = param.split('=')
      value = value.replace(/['"]+/g, "") // for when the hash parameter contains quotes.
      value = decodeURIComponent(value)
      if (key === "extModules") {
        try {
          hashParams[key] = eval(value) // for when the extModules parameter is an array/object.
        } catch (e) { // If eval doesn't work, just add the value as a string.
          console.warn("The extModules parameter should be either be a URL without quotes or a proper array containing individual URL(s) inside quotes!", e)
          hashParams[key] = value
        }
      } else {
        hashParams[key] = value
      }
    })
    loadExtModules(hashParams["extModules"])
  }
}

const loadExtModules = (modules) => {
  modules = modules || hashParams["extModules"]

  const loadModule = (modulePath) => {
    console.log(`Loading external module at ${modulePath}`)
    const scriptElement = document.createElement('script')
    scriptElement.src = modulePath
    scriptElement.async = ""
    scriptElement.type = "text/javascript"
    document.head.appendChild(scriptElement)
  }

  if (modules) {
    if (Array.isArray(modules)) {
      modules.forEach(modulePath => loadModule(modulePath))
    } else if (typeof (modules) === "string") {
      loadModule(modules)
    }
  }
}

iris.ui.writeToConsole = (text, changeLastLine = false, addSeparator) => {
  if (changeLastLine) {
    document.getElementById("console").lastElementChild.innerText = text
  } else {
    if (addSeparator === "before") {
      document
        .getElementById("console")
        .insertAdjacentHTML('beforeend', `<hr class="my-3 border-t-2 border-dashed border-green-700" />`)
    }
    const textElement = document.createElement("p")
    textElement.className = "text-green-500 font-mono"
    textElement.innerText = text
    document
      .getElementById("console")
      .insertAdjacentElement('beforeend', textElement)

    if (addSeparator === "after") {
      document
        .getElementById("console")
        .insertAdjacentHTML('beforeend', `<hr class="my-3 border-t-2 border-dashed border-green-700" />`)
    }
  }
  document.getElementById("consoleParent").scrollTop = !iris.consoleScrolled ? document.getElementById("consoleParent").scrollHeight - document.getElementById("consoleParent").offsetHeight : document.getElementById("consoleParent").scrollTop
}

iris.ui.recordScrolled = () => {
  if (document.getElementById("consoleParent").scrollTop === (document.getElementById("consoleParent").scrollHeight - document.getElementById("consoleParent").offsetHeight)) {
    iris.consoleScrolled = false
  } else {
    iris.consoleScrolled = true
  }
}

iris.setupIndexedDB = (
  dbName,
  objectStoreName,
  objectStoreOpts = {},
  indexOpts
) => new Promise((resolve) => {
  const dbRequest = window.indexedDB.open(dbName)
  dbRequest.onupgradeneeded = () => {
    const db = dbRequest.result
    if (!db.objectStoreNames.contains(objectStoreName)) {
      const objectStore = db.createObjectStore(
        objectStoreName,
        objectStoreOpts
      )
      if (indexOpts) {
        objectStore.createIndex(
          indexOpts.name,
          indexOpts.keyPath,
          indexOpts.objectParameters
        )
      }
    }
  }
  dbRequest.onsuccess = (evt) => {
    const db = evt.target.result
    resolve(db)
  }
})

iris.writeToIndexedDB = (objectStoreName, obj) =>
  new Promise((resolve) => {
    const objectStore = iris.mnistDB
      .transaction(objectStoreName, "readwrite")
      .objectStore(objectStoreName)
    objectStore.put(obj).onsuccess = ({ target }) => resolve(target.result)
  })

iris.getRecordsCount = (objectStoreName) =>
  new Promise((resolve) => {
    const objectStore = iris.mnistDB
      .transaction(objectStoreName, "readwrite")
      .objectStore(objectStoreName)
    objectStore.count().onsuccess = ({ target }) => resolve(target.result)
  })

iris.getFromIndexedDB = (objectStore, queryOpts = {}) =>
  new Promise((resolve, reject) => {
    const objectStoreTransaction = iris.mnistDB
      .transaction(objectStore, "readonly")
      .objectStore(objectStore)

    if (queryOpts.query === "all") {
      objectStoreTransaction.getAll().onsuccess = (e) => {
        resolve({ result: e.target.result })
      }
    } else if (
      Array.isArray(queryOpts.query) ||
      typeof queryOpts.query === "string" ||
      typeof queryOpts.query === "number"
    ) {
      // Return a single row.
      const attemptGet = objectStoreTransaction.get(queryOpts.query)
      attemptGet.onsuccess = (e) => {
        resolve({ result: e.target.result })
      }
      attemptGet.onerror = (e) => {
        reject(e.target.result)
      }
    } else {
      // Return a paginated response.
      const queryResult = []
      let offset =
        typeof queryOpts.offset === "number" && queryOpts.offset >= 0
          ? queryOpts.offset
          : 0
      queryOpts.limit =
        typeof queryOpts.limit === "number" && queryOpts.limit > 0
          ? queryOpts.limit
          : 25
      // let numRecords = 0
      // numRecords = e.target.result

      let cursorSource = objectStoreTransaction
      if (queryOpts.index) {
        cursorSource = objectStoreTransaction.index(queryOpts.index)
      }

      let pagesSkippedFlag = queryOpts.pageNum && queryOpts.pageNum > 0

      const cursorRequest = cursorSource.openCursor(
        queryOpts.query,
        queryOpts.direction
      )
      cursorRequest.onsuccess = (e) => {
        const cursor = e.target.result
        if (!cursor) {
          // console.log(`No cursor, found ${queryResult.length} items for query`, queryOpts)
          resolve({ result: queryResult, offset })
          return
        }

        if (queryOpts.offset > 0 && !pagesSkippedFlag) {
          // console.log("Advancing by ", queryOpts.offset, numRecords)
          pagesSkippedFlag = true
          cursor.advance(queryOpts.offset)
          return
        }

        if (queryResult.length < queryOpts.limit) {
          if (
            queryOpts?.query?.lower &&
            Array.isArray(queryOpts?.query?.lower) &&
            queryOpts?.query?.upper &&
            Array.isArray(queryOpts?.query?.upper)
          ) {
            for (let i = 1; i < queryOpts.query.lower.length; i++) {
              if (
                window.indexedDB.cmp(
                  cursor.key.slice(i, queryOpts.query.lower.length),
                  queryOpts.query.lower.slice(i)
                ) < 0
              ) {
                // console.log("Skipping Because low", cursor.key.slice(0, queryOpts.query.lower.length), queryOpts.query.lower)
                cursor.continue([
                  ...cursor.key.slice(0, i),
                  ...queryOpts.query.lower.slice(i),
                  ...cursor.key.slice(queryOpts.query.lower.length),
                ])
                offset++
                return
              }
              if (
                window.indexedDB.cmp(
                  cursor.key.slice(i, queryOpts.query.upper.length),
                  queryOpts.query.upper.slice(i)
                ) > 0
              ) {
                // console.log("Skipping Because high", cursor.key.slice(0, queryOpts.query.lower.length), queryOpts.query.upper)
                cursor.continue([
                  ...cursor.key.slice(0, i),
                  cursor.key[i] + EPSILON,
                  ...queryOpts.query.upper.slice(i + 1),
                  ...cursor.key.slice(queryOpts.query.upper.length),
                ])
                offset++
                return
              }
            }
          }
          // console.log("FOUND!")
          queryResult.push(cursor.value)
          offset++
          cursor.continue()
        } else {
          resolve({ result: queryResult, offset })
        }
      }
      cursorRequest.onerror = (e) => {
        console.log(e)
      }
    }
  })

iris.setupWorker = () => {
  iris.worker = new Worker("./mnistWorker.js")
  iris.worker.onmessage = (e) => {
    const { op, data } = e.data
    switch (op) {
      case "loadManifest":
        if (data.message === "idxdb_write") {
          const consoleMessage = `${data.recordsStored}/${data.totalImages} records written to IndexedDB`
          iris.ui.writeToConsole(consoleMessage, true)
        } else if (data.message === "idxdb_success") {
          const manifestLoadedEvent = new Event("manifestLoaded")
          document.dispatchEvent(manifestLoadedEvent)
        }
        break
    }
  }
}

iris.loadManifest = (filename, objectStoreName, subsetSize) => 
  new Promise(resolve => {
    iris.worker.postMessage({
      op: "loadManifest",
      data: {
        filename,
        objectStoreName,
        subsetSize
      },
    })

    document.addEventListener("manifestLoaded", resolve)
  })

const subsetSize = 5000
iris.startTraining = async () => {
  // document.getElementById("console").innerHTML = ""
  iris.ui.writeToConsole("Initializing training...")
  iris.stop = false
  iris.setupWorker()

  document.getElementById("trainCNNBtn").innerText = "Stop training"
  document.getElementById("trainCNNBtn").classList.replace("bg-blue-900", "bg-red-900")
  document.getElementById("trainCNNBtn").classList.replace("hover:bg-blue-800", "hover:bg-red-800")
  document.getElementById("trainCNNBtn").onclick = iris.stopTraining

  iris.ui.writeToConsole("Setting up IndexedDB...")
  const trainingObjectStoreName = "trainingData"
  iris.mnistDB = await iris.setupIndexedDB(
    indexedDBConfig.dbName,
    trainingObjectStoreName,
    indexedDBConfig.objectStoreOpts,
    indexedDBConfig.objectStoreIndex
  )
  if ((await iris.getRecordsCount(trainingObjectStoreName)) !== subsetSize) {
    iris.ui.writeToConsole("Fetching training manifest...")
    // const trainingManifestRequestURL = `${filePickerEndpoint}?filename=${manifests["training"].filename}`
    // const trainingCSV = await (
    //   await utils.request(trainingManifestRequestURL, {}, false)
    // ).text()

    // const csvLines = trainingCSV.split("\n")

    // let idx = 0
    // for (const line of csvLines) {
    //   if (idx !== 0) {
    //     const [filename, label] = line.split(",").map((x) => x.trim())
    //     await iris.writeToIndexedDB(trainingObjectStoreName, {
    //       filename,
    //       label,
    //     })
    iris.ui.writeToConsole(`0 records written to IndexedDB`)
    await iris.loadManifest(manifests["training"].filename, trainingObjectStoreName, subsetSize)

    //   }
    //   idx += 1
    // }
  } else {
    iris.ui.writeToConsole("Training data already present in IndexedDB")
  }
  iris.visor = tfvis.visor()
  iris.trainModel()
}

iris.createModel = () => {
  const model = tf.sequential()

  // The first layer of the convolutional neural network plays a dual role:
  // it is both the input layer of the neural network and a layer that performs
  // the first convolution operation on the input. It receives the 28x28 pixels
  // black and white images. This input layer uses 16 filters with a kernel size
  // of 5 pixels each. It uses a simple RELU activation function which pretty
  // much just looks like this: __/
  model.add(
    tf.layers.conv2d({
      inputShape: [28, 28, 1],
      kernelSize: 5,
      filters: 6,
      activation: "tanh",
    })
  )

  // Changed to Average Pooling Layer
  model.add(tf.layers.avgPool2d({ poolSize: 2, strides: 2 }))

  // Changed to depthwiseConv2d layer
  model.add(
    tf.layers.conv2d({ kernelSize: 5, filters: 16, activation: "tanh" })
  )

  // Changed to Average Pooling Layer
  model.add(tf.layers.avgPool2d({ poolSize: 2, strides: 2 }))

  model.add(tf.layers.flatten({}))

  // added additional dense layer
  model.add(tf.layers.dense({ units: 84, activation: "tanh" }))
  model.add(tf.layers.dense({ units: 10, activation: "softmax" }))

  return model
}

iris.getBatch = async (
  objectStoreName,
  offset,
  limit,
  callback = () => { }
) => {
  const xs = []
  const labels = []

  const { result: files } = await iris.getFromIndexedDB(objectStoreName, {
    offset,
    limit,
  })

  const getTensorFromImage = async (file) => {
    const img = new Image()
    img.width = 28
    img.height = 28
    const fileRequestURL = `${filePickerEndpoint}?filename=${file.filename}`
    const abortController = new AbortController()
    const timeoutRequest = setTimeout(() => abortController.abort(), 10000)
    try {
      img.src = await (await utils.request(fileRequestURL, { signal: abortController.signal }, false)).text()
    } catch (e) {
      console.log(e)
      clearTimeout(timeoutRequest)
      return
    }
    clearTimeout(timeoutRequest)
    img.setAttribute("crossorigin", "Anonymous")
    img.onload = () => {
      const cv = document.createElement('canvas')
      cv.width = img.width
      cv.height = img.height
      const ctx = cv.getContext('2d')
      ctx.drawImage(img, 0, 0, 28, 28)
      // document.getElementById("tfjs-visor-container").firstElementChild.firstElementChild.appendChild(cv)
      const imageData = ctx.getImageData(0, 0, 28, 28).data
      const grayscaledImage = []
      for (let i = 0; i < imageData.length; i += 4) {
        if (i % (28 * 4) === 0) {
          grayscaledImage.push([])
        }
        const maxPixelIntensity = Math.max(imageData[i], imageData[i + 1], imageData[i + 2])
        if (maxPixelIntensity > 0) {
          grayscaledImage[grayscaledImage.length - 1].push([1])
        } else {
          grayscaledImage[grayscaledImage.length - 1].push([0])
        }
      }

      xs.push(grayscaledImage)
      labels.push(parseInt(file.label))
    }
  }

  const ret = []
  const executing = []
  const poolLimit = 50
  for (const file of files) {
    const p = Promise.resolve().then(() => {
      if (!iris.stop) {
        return getTensorFromImage(file, files)
      } else {
        return Promise.resolve()
      }
    })
    ret.push(p)

    if (poolLimit <= files.length && !iris.stop) {
      const e = p.then(() => {
        executing.splice(executing.indexOf(e), 1)
        callback(xs)
      })
      executing.push(e)
      if (executing.length >= poolLimit) {
        await Promise.race(executing)
      }
    }
  }

  await Promise.allSettled(ret)
  return tf.tidy(() => {
    return {
      'xs': tf.tensor4d(xs, [xs.length, 28, 28, 1]),
      'labels': tf.oneHot(labels, iris.mnist_NUM_CLASSES),
    }
  })
}

iris.trainModel = async () => {
  iris.ui.writeToConsole("Creating model architecture:")
  iris.mnistModel = iris.createModel()

  const optimizer = "rmsprop"
  const loss = "categoricalCrossentropy"
  iris.mnistModel.compile({
    optimizer,
    loss,
    metrics: ["accuracy", "mse"],
  })

  iris.ui.writeToConsole(`Compiled model with ${optimizer} optimizer and ${loss} loss, ready for training`)
  const surface = iris.visor.surface({ name: 'Model Summary', tab: 'Model Inspection' })
  tfvis.show.modelSummary(surface, iris.mnistModel)

  const imagesPerGroup = 500
  const validationSplit = 0.15
  const totalNumGroups = subsetSize / imagesPerGroup
  const batchSize = 100
  const epochsToTrainFor = 3
  const totalNumEpochs = totalNumGroups * epochsToTrainFor
  iris.modelTrainingSurface = { name: "Model Training", tab: "Training" }
  const metricsVisualizerCallback = tfvis.show.fitCallbacks(iris.modelTrainingSurface, ['loss', 'acc'], ['onEpochEnd'])
  iris.currentEpochNum = 0

  for (let currentBatchNum = 0; currentBatchNum < totalNumGroups; currentBatchNum++) {
    if (!iris.stop) {
      iris.ui.writeToConsole(`Starting group ${currentBatchNum + 1}/${totalNumGroups}`, false, "before")
      await iris.trainForEpoch(imagesPerGroup, currentBatchNum, batchSize, validationSplit, epochsToTrainFor, metricsVisualizerCallback)
    }
  }
  iris.ui.writeToConsole("Model successfully trained!")
}

iris.trainForEpoch = async (
  imagesPerGroup,
  currentBatchNum,
  batchSize,
  validationSplit,
  epochsToTrainFor,
  metricsVisualizerCallback
) => {
  iris.ui.writeToConsole(
    `0/${imagesPerGroup} images fetched for current group`,
    true
  )
  const imageFetchCallback = (xs) => {
    if (!iris.stop) {
      iris.ui.writeToConsole(
        `${xs.length}/${imagesPerGroup} images fetched for current group`,
        true
      )
    }
  }
  const batchData = await iris.getBatch("trainingData", currentBatchNum * imagesPerGroup, imagesPerGroup, imageFetchCallback)
  let trainBatchCount = 0
  console.log(batchData)
  await iris.mnistModel.fit(batchData.xs, batchData.labels, {
    batchSize,
    validationSplit,
    epochs: epochsToTrainFor,
    shuffle: true,
    callbacks: {
      onBatchEnd: (batch, logs) => {
        trainBatchCount++
        iris.ui.writeToConsole(
          `Epoch ${iris.currentEpochNum} ${(trainBatchCount / (imagesPerGroup / batchSize) * 100).toFixed(1)}% complete: Loss = ${logs.loss} ; Accuracy = ${logs.acc}`
        )
      },
      onEpochBegin: () => {
        iris.currentEpochNum++
        trainBatchCount = 0
      },
      onEpochEnd: (epoch, logs) => {
        metricsVisualizerCallback.onEpochEnd(epoch, logs)
        const weightsToBeShared = []
        iris.mnistModel.layers.forEach(layer => {
          const layerWeights = layer.getWeights().map(weightMat => {
            console.log(weightMat)
            return weightMat.data()
          }).flat()
          weightsToBeShared.push(layerWeights)
        })
        iris.broadcastToAllPeers(localStorage.currentFederationId, localStorage.clientId, {
          epoch,
          weights: weightsToBeShared
        })
        iris.ui.writeToConsole(`Training Epoch ${iris.currentEpochNum} completed`)
        iris.writeToConsole(`Validation Loss = ${logs.val_loss} ; Validation Accuracy = ${logs.val_acc}`)

      }
    }
  })
}

iris.stopTraining = () => {
  iris.stop = true
  iris.worker.terminate()
  document.getElementById("trainCNNBtn").innerText = "Train CNN"
  document
    .getElementById("trainCNNBtn")
    .classList.replace("bg-red-900", "bg-blue-900")
  document
    .getElementById("trainCNNBtn")
    .classList.replace("hover:bg-red-800", "hover:bg-blue-800")
  document.getElementById("trainCNNBtn").onclick = iris.startTraining
  iris.writeToConsole("Terminated. ")
}

iris.trainLRSimple = async (datasetIndex=1, iid=true) => {
  const prefixFilePathString = iid ? 'iid' : 'noniid'
  const irisData = await (await fetch(`https://episphere.github.io/lab/iris_${prefixFilePathString}_${datasetIndex}.json`)).json()
  
  const trainSplit = 0.8
  const trainSplitIndex = Math.floor(irisData.length) * trainSplit
  const irisTrainingData = irisData.sort(() => Math.random() - 0.5).slice(0,trainSplitIndex)
  const irisTestData = irisData.slice(trainSplitIndex)

  // const trainingData = irisTrainingData.map(({sepal_length, sepal_width, petal_length, petal_width}) => tf.tensor1d([
  //   sepal_length, sepal_width, petal_length, petal_width
  // ]))
  
  // const trainingLabels = irisTrainingData.map(({species}) => tf.tensor1d([
  //   species === "setosa" ? 1 : 0,
  //   species === "virginica" ? 1 : 0,
  //   species === "versicolor" ? 1 : 0,
  // ]))
  const trainingData = tf.tensor2d(irisTrainingData.map(({sepal_length, sepal_width, petal_length, petal_width}) => [
    sepal_length, sepal_width, petal_length, petal_width
  ]))
  
  const trainingLabels = tf.tensor2d(irisTrainingData.map(({species}) => [
    species === "setosa" ? 1 : 0,
    species === "virginica" ? 1 : 0,
    species === "versicolor" ? 1 : 0,
  ]))
  
  const testData = tf.tensor2d(irisTestData.map(({sepal_length, sepal_width, petal_length, petal_width}) => [
    sepal_length, sepal_width, petal_length, petal_width
  ]))

  const testLabels = tf.tensor2d(irisTestData.map(({species}) => [
    species === "setosa" ? 1 : 0,
    species === "virginica" ? 1 : 0,
    species === "versicolor" ? 1 : 0,
  ]))
  
  const model = tf.sequential() 

  model.add(tf.layers.dense({
    inputShape: [4],
    activation: 'softmax',
    units: 3
  }))
  // model.add(tf.layers.dense({
  //   inputShape: [5],
  //   activation: "sigmoid",
  //   units: 3,
  // }))
  // model.add(tf.layers.dense({
  //   activation: "softmax",
  //   units: 3,
  // }))
  model.compile({
    loss: "binaryCrossentropy",
    optimizer: tf.train.adam(.0008),
    metrics: ["accuracy"]
  })
  model.summary()
  // train/fit our network
  iris.ui.writeToConsole("Starting training...")
  
  tfvis.visor()
  tfvis.show.modelSummary({
    'name': "Model Architecture",
    'tab': "Model"
  }, model)
  model.layers.forEach(async (layer, index) => {
    tfvis.show.layer({
      'name': `Layer ${index+1}`,
      'tab': "Model"
    }, layer)
  })

  // for (let epoch = 0; epoch < 50; epoch++) {
  // for (let row in trainingData) {
  //   const gradientUpdate = await model.trainOnBatch(trainingData[row], trainingLabels[row])
  // }
  await model.fit(trainingData, trainingLabels, {
    batchSize: irisTrainingData.length,
    epochs: 50,
    // initialEpoch: epoch,
    callbacks: tfvis.show.fitCallbacks({
      'name': "Training",
      'tab': "Training"
    }, ["loss", "acc"], {
      'callbacks': ["onEpochEnd"]
    })
  })
  // console.log("Loss:",gradientUpdate.history.loss[0])
  // console.log("Accuracy:",gradientUpdate.history.acc[0])
  iris.ui.writeToConsole(`Training finished.`)

  const predictions = model.predict(testData)
  predictions.print()
  tf.metrics.categoricalAccuracy(testLabels, predictions).print()
}

iris.trainLR = async (datasetIndex=1, iid=true) => {
  const prefixFilePathString = iid ? 'iid' : 'noniid'
  const irisData = await (await fetch(`https://episphere.github.io/lab/iris_${prefixFilePathString}_${datasetIndex}.json`)).json()
  
  const trainSplit = 0.8
  const trainSplitIndex = Math.floor(irisData.length) * trainSplit
  const irisTrainingData = irisData.sort(() => Math.random() - 0.5).slice(0,trainSplitIndex)
  const irisTestData = irisData.slice(trainSplitIndex)

  // const trainingData = irisTrainingData.map(({sepal_length, sepal_width, petal_length, petal_width}) => tf.tensor1d([
  //   sepal_length, sepal_width, petal_length, petal_width
  // ]))
  
  // const trainingLabels = irisTrainingData.map(({species}) => tf.tensor1d([
  //   species === "setosa" ? 1 : 0,
  //   species === "virginica" ? 1 : 0,
  //   species === "versicolor" ? 1 : 0,
  // ]))
  const trainingData = tf.tensor2d(irisTrainingData.map(({sepal_length, sepal_width, petal_length, petal_width}) => [
    sepal_length, sepal_width, petal_length, petal_width
  ]))
  
  const trainingLabels = tf.tensor2d(irisTrainingData.map(({species}) => [
    species === "setosa" ? 1 : 0,
    species === "virginica" ? 1 : 0,
    species === "versicolor" ? 1 : 0,
  ]))
  
  const testData = tf.tensor2d(irisTestData.map(({sepal_length, sepal_width, petal_length, petal_width}) => [
    sepal_length, sepal_width, petal_length, petal_width
  ]))

  const testLabels = tf.tensor2d(irisTestData.map(({species}) => [
    species === "setosa" ? 1 : 0,
    species === "virginica" ? 1 : 0,
    species === "versicolor" ? 1 : 0,
  ]))
  
  const model = tf.sequential() 

  model.add(tf.layers.dense({
    inputShape: [4],
    activation: 'softmax',
    units: 3
  }))
  // model.add(tf.layers.dense({
  //   inputShape: [5],
  //   activation: "sigmoid",
  //   units: 3,
  // }))
  // model.add(tf.layers.dense({
  //   activation: "softmax",
  //   units: 3,
  // }))
  model.compile({
    loss: "binaryCrossentropy",
    optimizer: tf.train.adam(.0008),
    metrics: ["accuracy"]
  })
  model.summary()
  // train/fit our network
  let responseFromPeers = {}
  responseFromPeers['peersReady'] = responseFromPeers['peersReady'] || new Set()
  responseFromPeers['weightUpdates'] = responseFromPeers['weightUpdates'] || []
  
  document.body.addEventListener("peerMessage", ({detail: e}) => {
    if (e.message.op === "startTraining") {
      if (e.message.data.ready) {
        webFed.sendDataToPeer(e.userID, {
          'op': "startTraining",
          'data': {
            'ack': true
          }
        })
      } else if (e.message.data.ack) {
        // Nothing to be done really
      }
      responseFromPeers['peersReady'].add(e.userID)
    }
    else if (e.message.op === "layerWiseWeights") {
      let objIndex = responseFromPeers['weightUpdates'].findIndex(o => o.epoch === e.message.data.epoch)
      if (objIndex === -1) {
        responseFromPeers['weightUpdates'].push({
          'epoch': e.message.data.epoch,
          'weightUpdates': []
        })
        objIndex = responseFromPeers['weightUpdates'].length - 1
      }
      responseFromPeers['weightUpdates'][objIndex].weightUpdates.push({
        'peerId': e.userID,
        'weights': e.message.data.layerWiseWeights
      })
    }
  })
  
  webFed.broadcastData({
    'op': "startTraining",
    'data': {
      'ready': true
    }
  })
  
  let allPeersReady = false
  iris.ui.writeToConsole("Waiting for all peers to finish setting up...")
  
  while (!allPeersReady) {
    await new Promise(res => setTimeout(res, 500))
    allPeersReady = responseFromPeers['peersReady']?.size === iris.group.userIDs.size - 1
  }
  iris.ui.writeToConsole("All peers ready. Starting training...")
  
  await new Promise(res => setTimeout(res, 1000))
  tfvis.visor()
  tfvis.show.modelSummary({
    'name': "Model Architecture",
    'tab': "Model"
  }, model)
  model.layers.forEach(async (layer, index) => {
    tfvis.show.layer({
      'name': `Layer ${index+1}`,
      'tab': "Model"
    }, layer)
  })

  for (let epoch = 0; epoch < 50; epoch++) {
    console.log("Epoch", epoch)
    // for (let row in trainingData) {
    //   const gradientUpdate = await model.trainOnBatch(trainingData[row], trainingLabels[row])
    // }
    const gradientUpdate = await model.fit(trainingData, trainingLabels, {
      batchSize: irisTrainingData.length,
      epochs: epoch+1,
      initialEpoch: epoch,
      callbacks: tfvis.show.fitCallbacks({
        'name': "Training",
        'tab': "Training"
      }, ["loss", "acc"], {
        'callbacks': ["onEpochEnd"]
      })
    })
    // console.log("Loss:",gradientUpdate.history.loss[0])
    // console.log("Accuracy:",gradientUpdate.history.acc[0])
    const layerWiseWeights = model.trainableWeights.map(layer => layer.val.dataSync())
    console.log(layerWiseWeights)
    // console.log(layerWiseWeights)
    webFed.broadcastData({
      'op': "layerWiseWeights",
      'data': {
        epoch,
        layerWiseWeights
      }
    })

    let allResponsesReceived = false
    while(!allResponsesReceived) {
      await new Promise(res => setTimeout(res, 500))
      allResponsesReceived = responseFromPeers['weightUpdates'].find(o => o.epoch === epoch).weightUpdates.length === iris.group.userIDs.size - 1
    }

    const receivedWeights = responseFromPeers['weightUpdates'].find(o => o.epoch === epoch).weightUpdates.map(peerUpdate => {
      return peerUpdate.weights.map(arr => new Float32Array(arr))
    })
    receivedWeights.push(layerWiseWeights)
    console.log(receivedWeights)
    // Aggregate weights and move to the next batch/epoch.
    const aggregatedWeights = []
    for (let layer in receivedWeights[0]) {
    //   const layerWiseAverage = receivedWeights[0][layer].reduce((averagedWeights, curr, ind) => {
        const allLayerWiseWeights = receivedWeights.map(peer => peer[layer])
        let averagedLayerWiseWeights = []
        for (let i = 0; i < allLayerWiseWeights[0].length; i++) {
          let sumAtNode = 0
          for (let j = 0; j < allLayerWiseWeights.length; j++) {
            sumAtNode += allLayerWiseWeights[j][i]
          }
          averagedLayerWiseWeights.push(sumAtNode/receivedWeights.length)
        }
      //   averagedWeights.push(sumOfWeights.map(sumAtNode => sumAtNode/receivedWeights.length))
      //   return averagedWeights
      // },[])
      console.log(averagedLayerWiseWeights)
      aggregatedWeights.push(tf.tensor(averagedLayerWiseWeights, model.trainableWeights[layer].shape, model.trainableWeights[layer].dtype))
    }
    
    model.setWeights(aggregatedWeights)
    model.getWeights()[0].print()
    iris.ui.writeToConsole(`Successfully aggregated weights for epoch ${epoch}.`)
  }

  const predictions = model.predict(testData)
  predictions.print()
  tf.metrics.categoricalAccuracy(testLabels, predictions).print()
}

iris.ui.joinFederationHandler = async (federationId=localStorage.federationId, clientId=localStorage.clientId) => {
  if (!federationId) {
    federationId = document.getElementById("federationIdTextInput").value === '' ? undefined : document.getElementById("federationIdTextInput").value
  }
  if (!clientId) {
    clientId = crypto.randomUUID()
  }
  const newUserCallback = (e) => {
    console.log("New User", e.userID)
    iris.ui.writeToConsole(`New user ${e.userID} joined!`)
    iris.ui.enableTrainLR()
  }
  const newMessageCallback = (e) => {
    console.log(`New message from ${e.userID}:`, e.message)
    const peerMessageEvent = new CustomEvent("peerMessage", {detail: e})
    document.body.dispatchEvent(peerMessageEvent)
  }
  const { connectedClientId, connectedFederationId } = await webFed.initializeFederation({ clientId, federationId, newUserCallback, newMessageCallback })
  iris.group = webFed.group
  localStorage.clientId = connectedClientId
  localStorage.federationId = connectedFederationId
  document.getElementById("federationIdTextInput").value = connectedFederationId
  document.getElementById("joinFederationBtn").innerText = "Federation Joined!"
  document.getElementById("joinFederationBtn").classList.replace("bg-blue-900", "bg-green-900")
  document.getElementById("joinFederationBtn").classList.replace("hover:bg-blue-800", "hover:bg-green-800")
  document.getElementById("joinFederationBtn").classList.add("disabled")
}

iris.ui.enableTrainLR = (e) => {
  document.getElementById("trainLROptions").classList.remove("hidden")
}

iris.ui.trainLRHandler = (e) => {
  const datasetSelector = document.getElementById("datasetSelector")
  const iidCheckbox = document.getElementById("iidCheckbox")
  if (e.target.id === "trainCNNBtn") {
    iris.trainLR(datasetSelector.value, iidCheckbox.checked)
  } else {
    iris.trainLRSimple(datasetSelector.value, iidCheckbox.checked)
  }
}

window.onload = async () => {
  localStorage.clear()
  loadHashParams()
  
  document.getElementById("joinFederationBtn")?.addEventListener('click', () => { iris.ui.joinFederationHandler() })
  document.getElementById("trainCNNBtn")?.addEventListener('click', iris.ui.trainLRHandler)
  document.getElementById("trainLRBasicBtn")?.addEventListener('click', iris.ui.trainLRHandler)

  // document.addEventListener('federationsChanged', iris.ui.populateFederationsList)
  
}
window.onhashchange = loadHashParams;

export default iris;