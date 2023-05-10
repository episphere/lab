importScripts("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs")

let mnistDB
const indexedDBConfig = {
  dbName: "mnistDB",
  objectStoreName: {
    training: "trainingData",
    test: "testData",
  },
}
const filePickerEndpoint =
  "https://script.google.com/macros/s/AKfycbyS0oKEIPPN-qcp0RtX9VGFmu0rZ4MI8uMNm_OCPiwllXRBO_F4TTnEfOYavVzYTc3f/exec"

const fetchIndexedDBInstance = () =>
  new Promise((resolve) => {
    indexedDB.open(indexedDBConfig.dbName).onsuccess = (evt) => {
      dbInstance = evt.target.result
      resolve(dbInstance)
    }
  })

const getFromIndexedDB = (objectStore, queryOpts = {}) =>
  new Promise(async (resolve, reject) => {
    const objectStoreTransaction = mnistDB
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

const writeToIndexedDB = (objectStoreName, obj) =>
  new Promise(async (resolve) => {
    const objectStore = mnistDB
      .transaction(objectStoreName, "readwrite")
      .objectStore(objectStoreName)
    objectStore.put(obj).onsuccess = ({ target }) => resolve(target.result)
  })

const loadManifest = async (op, data) => {
  const trainingManifestRequestURL = `${filePickerEndpoint}?filename=${data.filename}`
  const trainingCSV = await (
    await fetch(trainingManifestRequestURL, {}, false)
  ).text()

  let csvLines = trainingCSV.split("\n")
  if (data.subsetSize) {
    csvLines = csvLines.sort(() => 0.5 - Math.random()).slice(0, data.subsetSize)
  }

  let recordsStored = 0
  mnistDB = mnistDB || (await fetchIndexedDBInstance())
  await Promise.all(
    csvLines.map(async (line, idx) => {
      if (idx !== 0) {
        const [filename, label] = line.split(",").map((x) => x.trim())
        await writeToIndexedDB(data.objectStoreName, {
          filename,
          label,
        })
        recordsStored += 1
        postMessage({
          op,
          'data': {
            'message': "idxdb_write",
            recordsStored,
            'totalImages': csvLines.length - 1,
          },
        })
      }
    })
  )
}

onmessage = async (evt) => {
  const { op, data } = evt.data

  switch (op) {
    case "loadManifest":
      await loadManifest(op, data)
      postMessage({
        op,
        'data': {
          'message': "idxdb_success"
        }
      })
      break
  }
}
