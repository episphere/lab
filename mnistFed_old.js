// import * as tf from '@tensorflow/tfjs'
import webFed from "./webFed.js"

const mnist = {}
mnist.ui = {}
mnist.mnistDB = {}
mnist.mnist_NUM_CLASSES = 10
mnist.stop = false

mnist.DATA_SUBSET_SIZE_PER_PEER = 0.3

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

mnist.ui.writeToConsole = (text, changeLastLine = false, addSeparator) => {
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
  document.getElementById("consoleParent").scrollTop = !mnist.consoleScrolled ? document.getElementById("consoleParent").scrollHeight - document.getElementById("consoleParent").offsetHeight : document.getElementById("consoleParent").scrollTop
}

mnist.ui.recordScrolled = () => {
  if (document.getElementById("consoleParent").scrollTop === (document.getElementById("consoleParent").scrollHeight - document.getElementById("consoleParent").offsetHeight)) {
    mnist.consoleScrolled = false
  } else {
    mnist.consoleScrolled = true
  }
}

mnist.setupIndexedDB = (
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

mnist.writeToIndexedDB = (objectStoreName, obj) =>
  new Promise((resolve) => {
    const objectStore = mnist.mnistDB
      .transaction(objectStoreName, "readwrite")
      .objectStore(objectStoreName)
    objectStore.put(obj).onsuccess = ({ target }) => resolve(target.result)
  })

mnist.getRecordsCount = (objectStoreName) =>
  new Promise((resolve) => {
    const objectStore = mnist.mnistDB
      .transaction(objectStoreName, "readwrite")
      .objectStore(objectStoreName)
    objectStore.count().onsuccess = ({ target }) => resolve(target.result)
  })

mnist.getFromIndexedDB = (objectStore, queryOpts = {}) =>
  new Promise((resolve, reject) => {
    const objectStoreTransaction = mnist.mnistDB
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

mnist.setupWorker = () => {
  mnist.worker = new Worker("./mnistWorker.js")
  mnist.worker.onmessage = (e) => {
    const { op, data } = e.data
    switch (op) {
      case "loadManifest":
        if (data.message === "idxdb_write") {
          const consoleMessage = `${data.recordsStored}/${data.totalImages} records written to IndexedDB`
          mnist.ui.writeToConsole(consoleMessage, true)
        } else if (data.message === "idxdb_success") {
          const manifestLoadedEvent = new Event("manifestLoaded")
          document.dispatchEvent(manifestLoadedEvent)
        }
        break
    }
  }
}

mnist.loadManifest = (filename, objectStoreName, subsetSize) => 
  new Promise(resolve => {
    mnist.worker.postMessage({
      op: "loadManifest",
      data: {
        filename,
        objectStoreName,
        subsetSize
      },
    })

    document.addEventListener("manifestLoaded", resolve)
  })

const subsetSize = 4000
mnist.startTraining = async () => {
  // document.getElementById("console").innerHTML = ""
  mnist.ui.writeToConsole("Initializing training...")
  mnist.stop = false
  mnist.setupWorker()

  document.getElementById("trainCNNBtn").innerText = "Stop training"
  document
    .getElementById("trainCNNBtn")
    .classList.replace("bg-blue-900", "bg-red-900")
  document
    .getElementById("trainCNNBtn")
    .classList.replace("hover:bg-blue-800", "hover:bg-red-800")
  document.getElementById("trainCNNBtn").onclick = mnist.stopTraining

  mnist.ui.writeToConsole("Setting up IndexedDB...")
  const trainingObjectStoreName = "trainingData"
  mnist.mnistDB = await mnist.setupIndexedDB(
    indexedDBConfig.dbName,
    trainingObjectStoreName,
    indexedDBConfig.objectStoreOpts,
    indexedDBConfig.objectStoreIndex
  )
  if ((await mnist.getRecordsCount(trainingObjectStoreName)) !== subsetSize) {
    mnist.ui.writeToConsole("Fetching training manifest...")
    // const trainingManifestRequestURL = `${filePickerEndpoint}?filename=${manifests["training"].filename}`
    // const trainingCSV = await (
    //   await utils.request(trainingManifestRequestURL, {}, false)
    // ).text()

    // const csvLines = trainingCSV.split("\n")

    // let idx = 0
    // for (const line of csvLines) {
    //   if (idx !== 0) {
    //     const [filename, label] = line.split(",").map((x) => x.trim())
    //     await mnist.writeToIndexedDB(trainingObjectStoreName, {
    //       filename,
    //       label,
    //     })
    mnist.ui.writeToConsole(`0 records written to IndexedDB`)
    await mnist.loadManifest(manifests["training"].filename, trainingObjectStoreName, subsetSize)

    //   }
    //   idx += 1
    // }
  } else {
    mnist.ui.writeToConsole("Training data already present in IndexedDB")
  }
  mnist.visor = tfvis.visor()
  mnist.trainModel()
}

mnist.createModel = () => {
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
mnist.getBatch = async (
  objectStoreName,
  offset,
  limit,
  callback = () => {}
) => {
  const xs = []
  const labels = []

  const { result: files } = await mnist.getFromIndexedDB(objectStoreName, {
    offset,
    limit,
  })
  
  const getTensorFromImage = (file) => new Promise(async (res) => {
    const img = new Image()
    img.width = 28
    img.height = 28
    const fileRequestURL = `${filePickerEndpoint}?filename=${file.filename}`
    const abortController = new AbortController()
    const timeoutRequest = setTimeout(() => abortController.abort(), 10000)
    try {
      img.src = await (await utils.request(fileRequestURL, {signal: abortController.signal}, false)).text()
    } catch (e) {
      console.log(e)
      clearTimeout(timeoutRequest)  
      res()
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
      for (let i = 0; i < imageData.length; i+=4) {
        if (i % (28*4) === 0) {
          grayscaledImage.push([])
        }
        const maxPixelIntensity = Math.max(imageData[i], imageData[i+1], imageData[i+2])
        if (maxPixelIntensity > 0) {
          grayscaledImage[grayscaledImage.length-1].push([1])
        } else {
          grayscaledImage[grayscaledImage.length-1].push([0])
        }
      }
      
      xs.push(grayscaledImage)
      labels.push(parseInt(file.label))
      res()
    }
  })

  const ret = []
  const executing = []
  const poolLimit = 50
  for (const file of files) {
    const p = Promise.resolve().then(() => {
      if (!mnist.stop) {
        return getTensorFromImage(file, files)
      } else {
        return Promise.resolve()
      }
    })
    ret.push(p)

    if (poolLimit <= files.length && !mnist.stop) {
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
      'labels': tf.oneHot(labels, mnist.mnist_NUM_CLASSES),
    }
  })
}

mnist.trainModel = async () => {
  mnist.ui.writeToConsole("Creating model architecture:")
  mnist.mnistModel = mnist.createModel()

  const optimizer = "rmsprop"
  const loss = "categoricalCrossentropy"
  mnist.mnistModel.compile({
    optimizer,
    loss,
    metrics: ["accuracy", "mse"],
  })

  mnist.ui.writeToConsole(`Compiled model with ${optimizer} optimizer and ${loss} loss, ready for training`)
  const surface = mnist.visor.surface({ name: 'Model Summary', tab: 'Model Inspection' })
  tfvis.show.modelSummary(surface, mnist.mnistModel)

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
          'epoch': e.message.data.currentEpoch,
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
  mnist.ui.writeToConsole("Waiting for all peers to finish setting up...")
  
  while (!allPeersReady) {
    await new Promise(res => setTimeout(res, 500))
    allPeersReady = responseFromPeers['peersReady']?.size === mnist.group.userIDs.size - 1
  }
  mnist.ui.writeToConsole("All peers ready. Starting training...")
  
  await new Promise(res => setTimeout(res, 1000))
  
  const imagesPerGroup = 100
  const validationSplit = 0.15
  const totalNumGroups = subsetSize / imagesPerGroup
  const batchSize = 100
  let currentEpoch = 0
  const epochsToTrainFor = 3
  const totalNumEpochs = totalNumGroups * epochsToTrainFor
  mnist.modelTrainingSurface = { name: "Model Training", tab: "Training" }
  const metricsVisualizerCallback = tfvis.show.fitCallbacks(mnist.modelTrainingSurface, ['loss', 'acc'], ['onEpochEnd'])
  mnist.currentEpochNum = 0

  for (let currentBatchNum = 0; currentBatchNum < totalNumGroups; currentBatchNum++) {
    if (!mnist.stop) {
      mnist.ui.writeToConsole(`Starting group ${currentBatchNum + 1}/${totalNumGroups}`, false, "before")
      await mnist.trainForEpoch(imagesPerGroup, currentBatchNum, batchSize, validationSplit, currentEpoch, epochsToTrainFor, metricsVisualizerCallback)
      const layerWiseWeights = mnist.mnistModel.trainableWeights.map(layer => layer.val.dataSync())
      console.log(layerWiseWeights)
      // console.log(layerWiseWeights)
      webFed.broadcastData({
        'op': "layerWiseWeights",
        'data': {
          'currentEpoch': currentEpoch,
          layerWiseWeights
        }
      })
      
      let allResponsesReceived = false
      while(!allResponsesReceived) {
        await new Promise(res => setTimeout(res, 500))
        allResponsesReceived = responseFromPeers['weightUpdates'].find(o => o.epoch === currentEpoch)?.weightUpdates.length === mnist.group.userIDs.size - 1
        console.log(mnist.group.userIDs, responseFromPeers, allResponsesReceived)
      }
      const receivedWeights = responseFromPeers['weightUpdates'].find(o => o.epoch === currentEpoch).weightUpdates.map(peerUpdate => {
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
          aggregatedWeights.push(tf.tensor(averagedLayerWiseWeights, mnist.mnistModel.trainableWeights[layer].shape, mnist.mnistModel.trainableWeights[layer].dtype))
        }
        
        mnist.mnistModel.setWeights(aggregatedWeights)
        mnist.mnistModel.getWeights()[0].print()
        mnist.ui.writeToConsole(`Successfully aggregated weights for epoch ${currentEpoch}.`)
        currentEpoch += epochsToTrainFor
        
      }
    }
    mnist.ui.writeToConsole("Model successfully trained!")
  }
  
  mnist.trainForEpoch = async (
    imagesPerGroup,
  currentBatchNum,
  batchSize,
  validationSplit,
  currentEpoch,
  epochsToTrainFor,
  metricsVisualizerCallback
) => {
  mnist.ui.writeToConsole(
    `0/${imagesPerGroup} images fetched for current group`,
    true
  )
  const imageFetchCallback = (xs) => {
    if (!mnist.stop) {
      mnist.ui.writeToConsole(
        `${xs.length}/${imagesPerGroup} images fetched for current group`,
        true
      )
    }
  }
  const batchData = await mnist.getBatch("trainingData", currentBatchNum * imagesPerGroup, imagesPerGroup, imageFetchCallback)
  let trainBatchCount = 0
  console.log(batchData)
  const gradientUpdate = await mnist.mnistModel.fit(batchData.xs, batchData.labels, {
    batchSize,
    validationSplit,
    epochs: currentEpoch+epochsToTrainFor,
    initialEpoch: currentEpoch,
    shuffle: true,
    callbacks: {
      onBatchEnd: (batch, logs) => {
        trainBatchCount++
        mnist.ui.writeToConsole(
          `Epoch ${mnist.currentEpochNum} ${(trainBatchCount / (imagesPerGroup / batchSize) * 100).toFixed(1)}% complete: Loss = ${logs.loss} ; Accuracy = ${logs.acc}`
        )
      },
      onEpochBegin: () => {
        mnist.currentEpochNum++
        trainBatchCount = 0
      },
      onEpochEnd: (epoch, logs) => {
        metricsVisualizerCallback.onEpochEnd(epoch, logs)
        // const weightsToBeShared = []
        // mnist.mnistModel.layers.forEach(layer => {
        //   const layerWeights = layer.getWeights().map(weightMat => {
        //     console.log(weightMat)
        //     return weightMat.data()
        //   }).flat()
        //   weightsToBeShared.push(layerWeights)
        // })
        // mnist.broadcastToAllPeers(localStorage.currentFederationId, localStorage.clientId, {
        //   epoch,
        //   weights: weightsToBeShared
        // })
        mnist.ui.writeToConsole(`Training Epoch ${mnist.currentEpochNum} completed`)
        mnist.ui.writeToConsole(`Validation Loss = ${logs.val_loss} ; Validation Accuracy = ${logs.val_acc}`)

      }
    }
  })
  return gradientUpdate
}

mnist.stopTraining = () => {
  mnist.stop = true
  mnist.worker.terminate()
  document.getElementById("trainCNNBtn").innerText = "Train CNN"
  document
    .getElementById("trainCNNBtn")
    .classList.replace("bg-red-900", "bg-blue-900")
  document
    .getElementById("trainCNNBtn")
    .classList.replace("hover:bg-red-800", "hover:bg-blue-800")
  document.getElementById("trainCNNBtn").onclick = mnist.startTraining
  mnist.ui.writeToConsole("Terminated. ")
}

mnist.trainLRBasic = async(datasetIndex=1, iid=true) => {
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
  const trainingLabels = irisTrainingData.map(({species}) => tf.tensor1d([
    species === "setosa" ? 1 : 0,
    species === "virginica" ? 1 : 0,
    species === "versicolor" ? 1 : 0,
  ]))
  
  const testData = tf.tensor2d(irisTestData.map(({sepal_length, sepal_width, petal_length, petal_width}) => [
    sepal_length, sepal_width, petal_length, petal_width
  ]))

  const weights = tf.tidy(() => tf.variable(tf.randomNormal([4,1], 0, 1.0), true))
  const bias = tf.tidy(() => tf.variable(tf.randomNormal([1], 0, 1.0), true))

  console.log("Weights before:", weights.dataSync())
  console.log("Bias before", bias.dataSync())

  const model = (trainData) =>
     trainData.matMul(weights)
      .add(bias)
      .sigmoid()

  const lossFunc = (predicted, actual) => tf.metrics.categoricalCrossentropy(actual, predicted)

  const optimizer = tf.train.adam(0.001)

  for (let epoch=0; epoch<100; epoch++) {
    console.log("===================================================================")
    console.log("Epoch", epoch)
    const loss = tf.tidy(() => optimizer.minimize(() => lossFunc(model(trainingData), trainingLabels), true))
    console.log("Loss:", loss.dataSync())
    console.log("Weights after", weights.dataSync())
    console.log("Bias after", bias.dataSync())
    // console.log(tf.round(model(trainingData)).dataSync())
    console.log(lossFunc(model(trainingData), trainingLabels).dataSync())
    const accuracy = tf.tidy(() => tf.metrics.categoricalAccuracy(trainingLabels, tf.round(model(trainingData))))
    console.log("Accuracy:", accuracy.dataSync())
  }
}

// Federated functions
mnist.createFederation = async (description='') => {
  const newFederationId = await webFed.createFederation(undefined, description)
  return newFederationId
}

mnist.joinFederation = async (federationId, clientId) => {
  await webFed.joinFederation(federationId, clientId)
  localStorage.currentFederationId = federationId
  
  return federationId
}

mnist.ui.populateFederationsList = () => {
  const allFederationIds = webFed.getAllFederationIds()
  const federationsListParent = document.getElementById("federationIdsList")
  federationsListParent.innerHTML = ''
  
  allFederationIds.forEach((id, ind) => {
    const liElement = document.createElement('li')
    
    const selectFedBtn = document.createElement('button')
    selectFedBtn.id = `federation_${id}`
    selectFedBtn.className = "text-left block w-full whitespace-nowrap bg-transparent px-4 py-2 text-sm font-normal text-neutral-700 hover:bg-neutral-100 active:text-neutral-800 active:no-underline disabled:pointer-events-none dark:text-neutral-200 dark:hover:bg-neutral-600"
    selectFedBtn.setAttribute('data-te-dropdown-item-ref', '')
    selectFedBtn.innerText = id
    selectFedBtn.onclick = () => mnist.ui.joinFederationHandler(id)
    
    if (ind !== 0) {
      liElement.appendChild(document.createElement('hr'))
    }
    
    liElement.appendChild(selectFedBtn)
    federationsListParent.appendChild(liElement)
  })
  
  const joinFederationBtn = document.getElementById("joinFederationBtn")
  if (allFederationIds.length === 0) {
    joinFederationBtn.setAttribute("disabled", "true")
  } else {
    joinFederationBtn.removeAttribute("disabled")
  }
}

mnist.ui.addSelectorToFederationInList = (federationId) => {
  const federationsListParent = document.getElementById("federationIdsList")
  const previouslySelectedElement = federationsListParent.querySelector("button.font-semibold")
  previouslySelectedElement?.classList.remove("font-bold")
  previouslySelectedElement?.removeAttribute("disabled")
  const currentlySelectedFederation = document.getElementById(`federation_${federationId}`)
  currentlySelectedFederation.classList.add("font-bold")
  currentlySelectedFederation.setAttribute("disabled", "true")
}

mnist.ui.createFederationHandler = async (e) => {
  const newFederationId = await mnist.createFederation('')
  mnist.ui.writeToConsole(`New Federation created with ID: ${newFederationId}`)
  mnist.ui.populateFederationsList()
}

mnist.ui.joinFederationHandler = async (federationId=localStorage.federationId, clientId=localStorage.clientId) => {
  // document.addEventListener("newPeer", (e) => {
  //   mnist.ui.writeToConsole(`New Peer ${e.detail.peerId} just joined! Attempting connection...`)
  // })
  // document.addEventListener("peerConnected", (e) => {
  //   mnist.ui.writeToConsole(`Connection established with peer ${e.detail.peerId}!`)
  // })
  
  // mnist.ui.writeToConsole(`Joining federation ${federationId} as a client with ID: ${clientId}...`)
  // await mnist.joinFederation(federationId, clientId)
  
  // mnist.ui.writeToConsole(`Looking for peers...`)
  
  // mnist.ui.addSelectorToFederationInList(federationId)
  // document.getElementById("trainCNNBtn").parentElement.classList.remove("hidden")

  if (!federationId) {
    federationId = document.getElementById("federationIdTextInput").value === '' ? undefined : document.getElementById("federationIdTextInput").value
  }
  if (!clientId) {
    clientId = crypto.randomUUID()
  }
  const newUserCallback = (e) => {
    console.log("New User", e.userID)
    mnist.ui.writeToConsole(`New user ${e.userID} joined!`)
    mnist.ui.enableTrainLR()
  }
  const newMessageCallback = (e) => {
    console.log(`New message from ${e.userID}:`, e.message)
    const peerMessageEvent = new CustomEvent("peerMessage", {detail: e})
    document.body.dispatchEvent(peerMessageEvent)
  }
  const { connectedClientId, connectedFederationId } = await webFed.initializeFederation({ clientId, federationId, newUserCallback, newMessageCallback })
  mnist.group = webFed.group
  localStorage.clientId = connectedClientId
  localStorage.federationId = connectedFederationId
  document.getElementById("federationIdTextInput").value = connectedFederationId
  document.getElementById("joinFederationBtn").innerText = "Federation Joined!"
  document.getElementById("joinFederationBtn").classList.replace("bg-blue-900", "bg-green-900")
  document.getElementById("joinFederationBtn").classList.replace("hover:bg-blue-800", "hover:bg-green-800")
  document.getElementById("joinFederationBtn").classList.add("disabled")
}

mnist.ui.enableTrainLR = async (e) => {
  if (document.getElementById("trainLROptions").classList.contains("hidden")) {
    document.getElementById("optionsBtn").onclick = () => mnist.ui.showOptionsModal()
    document.getElementById("trainLROptions").classList.remove("hidden")
    mnist.ui.writeToConsole("Fetching data manifest...")
    const trainingManifestRequestURL = "https://script.google.com/macros/s/AKfycbyS0oKEIPPN-qcp0RtX9VGFmu0rZ4MI8uMNm_OCPiwllXRBO_F4TTnEfOYavVzYTc3f/exec?filename=trainingLabels.csv"
    const testManifestRequestURL = "https://script.google.com/macros/s/AKfycbyS0oKEIPPN-qcp0RtX9VGFmu0rZ4MI8uMNm_OCPiwllXRBO_F4TTnEfOYavVzYTc3f/exec?filename=testLabels.csv"
    const trainingCSV = await (
      await fetch(trainingManifestRequestURL, {}, false)
    ).text()
    const testCSV = await (
      await fetch(testManifestRequestURL, {}, false)
    ).text()
    mnist.ui.writeToConsole("Data loaded! Ready to train.")
    let trainingCSVLines = trainingCSV.split("\n").slice(1).sort(() => 0.5 - Math.random())
    // .slice(0, mnist.DATA_SUBSET_SIZE_PER_PEER)
    let testCSVLines = testCSV.split("\n").slice(1).sort(() => 0.5 - Math.random())
    // .slice(0, mnist.DATA_SUBSET_SIZE_PER_PEER)
  
    mnist.trainingData = trainingCSVLines.map((line, idx) => {
      const [filename, label] = line.split(",").map((x) => x.trim())
      return {
        filename, label
      }
    })
    mnist.testData = testCSVLines.map((line, idx) => {
      const [filename, label] = line.split(",").map((x) => x.trim())
      return {
        filename, label
      }
    })
  
    mnist.trainingDataSubset = mnist.trainingData.slice(0, Math.floor(mnist.trainingData.length*mnist.DATA_SUBSET_SIZE_PER_PEER))
    mnist.testDataSubset = mnist.trainingData.slice(0, Math.floor(mnist.testData.length*mnist.DATA_SUBSET_SIZE_PER_PEER))
  
    mnist.ui.addDatasetConfigOptions()
  }

}

mnist.ui.showOptionsModal = () => {
  mnist.ui.addDatasetConfigOptions()
  document.getElementById("modalBackdrop").parentElement.classList.remove("hidden")
  document.getElementById("modalBackdrop").classList.remove("opacity-0")
  document.getElementById("modalBackdrop").classList.remove("hidden")
  document.getElementById("modalBackdrop").classList.add("ease-out","duration-300","opacity-100")
  setTimeout(() => {
    document.getElementById("modalBackdrop").classList.remove("ease-out","duration-300")
  }, 300)
  document.getElementById("modalPanel").classList.remove("opacity-0", "translate-y-4", "sm:translate-y-0", "sm:scale-95")
  document.getElementById("modalPanel").classList.remove("hidden")
  document.getElementById("modalPanel").classList.add("ease-out","duration-300","opacity-100", "translate-y-0", "sm:scale-100")
  setTimeout(() => {
      document.getElementById("modalPanel").classList.remove("ease-out","duration-300")
  }, 300)
}

mnist.ui.removeDataSourceModal = () => {
  document.getElementById("modalPanel").classList.remove("opacity-100", "translate-y-0", "sm:scale-100")
  document.getElementById("modalPanel").classList.add("ease-in","duration-200", "opacity-0", "translate-y-4", "sm:translate-y-0", "sm:scale-95")
  setTimeout(() => {
      document.getElementById("modalPanel").classList.remove("ease-in", "duration-200")
      document.getElementById("modalPanel").classList.add("hidden")
  }, 200)
  document.getElementById("modalBackdrop").classList.remove("opacity-100")
  document.getElementById("modalBackdrop").classList.add("ease-in","duration-200","opacity-0")
  setTimeout(() => {
      document.getElementById("modalBackdrop").classList.remove("ease-in","duration-200")
      document.getElementById("modalBackdrop").classList.add("hidden")
      document.getElementById("modalBackdrop").parentElement.classList.add("hidden")
  }, 200)
}

mnist.ui.addDatasetConfigOptions = () => {
  const optionsParent = document.getElementById("optionsContent")

  const createLabelProportionSelector = () => {
    const labelProportions = [...mnist.trainingDataSubset].reduce((agg, row) => {
      if (!agg[row.label]) {
        agg[row.label] = 1
      } else {
        agg[row.label] += 1
      }
      return agg
    }, {})
    
    const proportionsListParent = document.createElement("div")
    proportionsListParent.id = "classProportionsParent"
    proportionsListParent.className = "text-white px-2 my-2"
    proportionsListParent.innerHTML = '';
    
    const proportionsListTitle = document.createElement("h5")
    proportionsListTitle.className = "text-lg text-white"
    proportionsListTitle.innerText = "Class Distribution"
    
    const proportionsList = document.createElement("ul")
    proportionsList.className = "list-none"
    
    Object.keys(labelProportions).sort((a,b) => a-b).forEach((label, ind) => {
      const liElement = document.createElement('li')
      console.log("prop", label, Math.round(labelProportions[label]*100/mnist.trainingDataSubset.length))
      const setPropSpan = document.createElement('span')
      setPropSpan.id = `classProportion_${label}`
      setPropSpan.className = "text-left block w-full whitespace-nowrap bg-transparent px-4 py-2 text-sm font-normal text-neutral-700 hover:bg-neutral-100 active:text-neutral-800 active:no-underline disabled:pointer-events-none dark:text-neutral-200 dark:hover:bg-neutral-600"
      setPropSpan.setAttribute('data-te-dropdown-item-ref', '')
      
      const rangeSlider = document.createElement('input')
      rangeSlider.id = setPropSpan.id + "_range"
      rangeSlider.className = "classProportionRange align-middle"
      rangeSlider.setAttribute('type', 'range')
      rangeSlider.setAttribute('label', label)
      rangeSlider.setAttribute('min', "0")
      rangeSlider.setAttribute('max', "100")
      rangeSlider.value = Math.round(labelProportions[label]*100/mnist.trainingDataSubset.length)
      
      const rangeSliderTextboxSpan = document.createElement('span')
      rangeSliderTextboxSpan.className = "align-middle px-1"
      const rangeSliderTextbox = document.createElement('input')
      rangeSliderTextbox.id = setPropSpan.id + "_rangeTextbox"
      rangeSliderTextbox.className = "classProportionRangeTextbox align-middle text-gray-600"
      rangeSliderTextbox.setAttribute('type', 'number')
      rangeSliderTextbox.setAttribute('value', rangeSlider.value)
      rangeSliderTextbox.setAttribute('min', rangeSlider.min)
      rangeSliderTextbox.setAttribute('max', rangeSlider.max)

      rangeSliderTextboxSpan.appendChild(rangeSliderTextbox)
      rangeSliderTextboxSpan.appendChild(document.createTextNode("%"))
      
      rangeSlider.onchange = () => {
        rangeSliderTextbox.value = rangeSlider.value
      }

      rangeSliderTextbox.onchange = () => {
        rangeSlider.value = rangeSliderTextbox.value
      }
      
      const setPropLabel = document.createElement("label")
      setPropLabel.className = "align-middle pr-2"
      setPropLabel.for = rangeSlider.id
      setPropLabel.innerText = label
  
      setPropSpan.appendChild(setPropLabel)
      setPropSpan.appendChild(rangeSlider)
      setPropSpan.appendChild(rangeSliderTextboxSpan)
      
      // if (ind !== 0) {
      //   liElement.appendChild(document.createElement('hr'))
      // }
      
      liElement.appendChild(setPropSpan)
      proportionsList.appendChild(liElement)
    })
    
    proportionsListParent.appendChild(proportionsListTitle)
    proportionsListParent.appendChild(proportionsList)
    return proportionsListParent
  }

  const createSubmitButtons = () => {
    const submitButtonsDiv = document.createElement("div")
    submitButtonsDiv.className = "grid grid-flow-col auto-cols-max gap-3 w-full justify-end my-3"
    
    const confirmOptionsBtn = document.createElement("button") 
    confirmOptionsBtn.className = "px-10 py-2 text-white text-base bg-green-900 rounded"
    confirmOptionsBtn.innerText = "Confirm"
    confirmOptionsBtn.onclick = () => {
      if (mnist.adjustDataSampling()) {
        mnist.ui.removeDataSourceModal()
      }
    }
    
    const closeOptionsBtn = document.createElement("button") 
    closeOptionsBtn.className = "px-10 py-2 text-white text-base bg-indigo-900 rounded"
    closeOptionsBtn.innerText = "Close"
    closeOptionsBtn.onclick = () => mnist.ui.removeDataSourceModal()
    
    submitButtonsDiv.appendChild(confirmOptionsBtn)
    submitButtonsDiv.appendChild(closeOptionsBtn)
    return submitButtonsDiv
  }

  if(optionsParent.childElementCount === 0) {
    const labelProportionSelector = createLabelProportionSelector()
    const submitButtons = createSubmitButtons()
    optionsParent.appendChild(labelProportionSelector)
    optionsParent.appendChild(document.createElement("hr"))
    optionsParent.appendChild(submitButtons)
  }
}

mnist.adjustDataSampling = () => {
  mnist.trainingDataSubset = []
  const proportionSelections = document.querySelectorAll(".classProportionRange")
  const proportionValues = {}
  proportionSelections.forEach(rangeElement => {
    const label = rangeElement.getAttribute("label")
    proportionValues[label] = rangeElement.value
  })
  const proportionValuesSum = Object.values(proportionValues).reduce((sum, labelProp) => {
    sum += parseFloat(labelProp)
    return sum
  }, 0)
  
  if (proportionValuesSum != 100) {
    alert("All class proportions should sum to 100!")
    return false
  }
  
  mnist.ui.writeToConsole("Class distribution changed. Resampling...")
  mnist.trainingData.sort(() => 0.5 - Math.random())
  
  Object.entries(proportionValues).forEach(([label, proportion]) => {
    const numEntries = Math.round(mnist.trainingData.length * mnist.DATA_SUBSET_SIZE_PER_PEER * proportion/100)
    const entries = mnist.trainingData.filter(x => x.label === label).slice(0, numEntries)
    mnist.trainingDataSubset = mnist.trainingDataSubset.concat(entries)
  })
  
  console.log(mnist.trainingDataSubset)
  
  mnist.ui.writeToConsole("Resampling complete.")
  return true
}

mnist.ui.trainLRHandler = (e) => {
  // const datasetSelector = document.getElementById("datasetSelector")
  // const iidCheckbox = document.getElementById("iidCheckbox")
  mnist.trainLR()
}

window.onload = async () => {
  localStorage.clear()
  loadHashParams()
  
  document.getElementById("federationIdTextInput").addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && e.target.value.length > 0) {
      mnist.ui.joinFederationHandler()
    }
  })
  document.getElementById("joinFederationBtn").addEventListener('click', () => mnist.ui.joinFederationHandler())
  document.getElementById("trainCNNBtn").addEventListener('click', () => mnist.startTraining())

  document.getElementById("consoleParent").addEventListener('scroll', mnist.recordScrolled)
  // mnist.ui.populateFederationsList()
  // document.addEventListener('federationsChanged', mnist.ui.populateFederationsList)
}
window.onhashchange = loadHashParams;