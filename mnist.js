// import * as tf from '@tensorflow/tfjs'

const mnist = {}
mnist.mnistDB = {}
mnist.mnist_NUM_CLASSES = 10
mnist.stop = false

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
  request: (url, opts, returnJson=true) =>
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

mnist.writeToConsole = (text, changeLastLine = false, addSeparator) => {
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

mnist.recordScrolled = () => {
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
) =>new Promise((resolve) => {
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
          mnist.writeToConsole(consoleMessage, true)
        } else if (data.message === "idxdb_success") {
          const manifestLoadedEvent = new Event("manifestLoaded")
          document.dispatchEvent(manifestLoadedEvent)
        }
        break
    }
  }
}

mnist.loadManifest = (filename, objectStoreName) => new Promise (resolve => {
  mnist.worker.postMessage({
    op: "loadManifest",
    data: {
      filename,
      objectStoreName,
    },
  })

  document.addEventListener("manifestLoaded", resolve)
})

mnist.startTraining = async () => {
  document.getElementById("console").innerHTML = ""
  mnist.writeToConsole("Initializing...")
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

  mnist.writeToConsole("Setting up IndexedDB...")
  const trainingObjectStoreName = "trainingData"
  mnist.mnistDB = await mnist.setupIndexedDB(
    indexedDBConfig.dbName,
    trainingObjectStoreName,
    indexedDBConfig.objectStoreOpts,
    indexedDBConfig.objectStoreIndex
  )
  if ((await mnist.getRecordsCount(trainingObjectStoreName)) !== manifests["training"].count
  ) {
    mnist.writeToConsole("Fetching training manifest...")
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
    mnist.writeToConsole(`0 records written to IndexedDB`)
    await mnist.loadManifest(manifests["training"].filename, trainingObjectStoreName)

    //   }
    //   idx += 1
    // }
  } else {
    mnist.writeToConsole("Training data already present in IndexedDB")
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
      filters: 8,
      activation: "relu",
    })
  )

  model.add(tf.layers.maxPooling2d({ poolSize: 2, strides: 2 }))

  model.add(
    tf.layers.conv2d({ kernelSize: 5, filters: 16, activation: "relu" })
  )

  model.add(tf.layers.maxPooling2d({ poolSize: 2, strides: 2 }))

  model.add(tf.layers.flatten({}))

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
  
  const getTensorFromImage = async (file) => {
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
    }
  }

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
  mnist.writeToConsole("Creating model architecture:")
  mnist.mnistModel = mnist.createModel()
  
  const optimizer = "rmsprop"
  const loss = "categoricalCrossentropy"
  mnist.mnistModel.compile({
    optimizer,
    loss,
    metrics: ["accuracy", "mse"],
  })
  
  mnist.writeToConsole(`Compiled model with ${optimizer} optimizer and ${loss} loss, ready for training`)
  const surface = mnist.visor.surface({ name: 'Model Summary', tab: 'Model Inspection'})
  tfvis.show.modelSummary(surface, mnist.mnistModel)

  const imagesPerGroup = 1000
  const validationSplit = 0.15
  const totalNumGroups = manifests["training"].count / imagesPerGroup
  const batchSize = 100
  const epochsToTrainFor = 3
  const totalNumEpochs = totalNumGroups * epochsToTrainFor
  mnist.modelTrainingSurface = { name: "Model Training", tab: "Training" }
  const metricsVisualizerCallback = tfvis.show.fitCallbacks(mnist.modelTrainingSurface, ['loss', 'acc'],['onEpochEnd'])
  mnist.currentEpochNum = 0
  
  for (let currentBatchNum = 0; currentBatchNum < totalNumGroups; currentBatchNum++ ) {
    if (!mnist.stop) {
      mnist.writeToConsole(`Starting group ${currentBatchNum + 1}/${totalNumGroups}`, false, "before")
      await mnist.trainForEpoch(imagesPerGroup, currentBatchNum, batchSize, validationSplit, epochsToTrainFor, metricsVisualizerCallback)
    }
  }
  mnist.writeToConsole("Model successfully trained!")
}

mnist.trainForEpoch = async (
  imagesPerGroup,
  currentBatchNum,
  batchSize,
  validationSplit,
  epochsToTrainFor,
  metricsVisualizerCallback
) => {
  mnist.writeToConsole(
    `0/${imagesPerGroup} images fetched for current group`,
    true
  )
  const imageFetchCallback = (xs) => {
    if (!mnist.stop) {
      mnist.writeToConsole(
        `${xs.length}/${imagesPerGroup} images fetched for current group`,
        true
      )
    }
  }
  const batchData = await mnist.getBatch("trainingData", currentBatchNum * imagesPerGroup, imagesPerGroup, imageFetchCallback)
  let trainBatchCount = 0
  console.log(batchData)
  await mnist.mnistModel.fit(batchData.xs, batchData.labels, {
    batchSize,
    validationSplit,
    epochs: epochsToTrainFor,
    shuffle: true,
    callbacks: {
      onBatchEnd: (batch, logs) => {
        trainBatchCount++
        mnist.writeToConsole(
          `Epoch ${mnist.currentEpochNum} ${(trainBatchCount / (imagesPerGroup/batchSize) * 100).toFixed(1)}% complete: Loss = ${logs.loss} ; Accuracy = ${logs.acc}`
        )
      },
      onEpochBegin: () => {
        mnist.currentEpochNum++
        trainBatchCount = 0
      },
      onEpochEnd: (epoch, logs) => {
        metricsVisualizerCallback.onEpochEnd(epoch, logs)
        mnist.writeToConsole(`Training Epoch ${mnist.currentEpochNum} completed`)
        mnist.writeToConsole(`Validation Loss = ${logs.val_loss} ; Validation Accuracy = ${logs.val_acc}`)
      }
    }
  })
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
  mnist.writeToConsole("Terminated. ")
}

window.onload = loadHashParams
window.onhashchange = loadHashParams