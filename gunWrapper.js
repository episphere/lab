import Gun from "https://cdn.skypack.dev/gun";

const GUN_SERVER = "https://d6a054a208765f61a368c5f3fe73e4c5.loophole.site/gun"
let gunInstance = {}

const gunDB = {

  initialize: (serverPath=GUN_SERVER) => {
    gunInstance = Gun(serverPath)
  },
  
  traverseDB: async (pathKeys = []) => {
    let parentObj = undefined
    
    if (pathKeys.length === 0) {
      parentObj = gunInstance
    } else {
      for (let prop of pathKeys) {
        parentObj = parentObj ? await parentObj.get(prop) : await gunInstance.get(prop)
      }
    }
    return parentObj
  },

  createObject: (pathKeys = [], newKey, value) => {
    return gunDB.updateObject([...pathKeys, newKey], value)
  },

  updateObject: (pathKeys=[], newValue) => {
    return new Promise(async (resolve, reject) => {
      let parentObj = await gunDB.traverseDB(pathKeys)

      if (typeof(newValue) !== 'undefined') {
        parentObj.put(newValue, (ack) => {
          if (ack.err) {
            reject(ack.err)
          } else {
            resolve()
          }
        })
      } else {
        resolve()
      }

    })
  },

    // addToList: async (pathKeys = [], newKey, value) => {
    //   return new Promise((resolve, reject) => {
    //     parentObj = gunDB.traverseDB(pathKeys)
    //     newObj = gunDB.get(newKey)
    //     newObj.put(value)

    //     parentObj.set(newObj, (ack) => {
    //       if (ack.err) {
    //         reject(ack.err)
    //       } else {
    //         resolve()
    //       }
    //     })

    //   })
    // },

  getObject: (pathKeys = []) => {
    return new Promise(async (resolve) => {
      let parentObj = await gunDB.traverseDB(pathKeys)
      
      parentObj.once((data) => {
        if (typeof (data) === 'object' && '_' in data) {
          const { _, ...result } = data
          resolve(result)
        } else {
          resolve(data)
        }
      })
      
    })
  },
  
  trackObject: async (pathKeys=[], cb, filter=true) => {
      let parentObj = await gunDB.traverseDB(pathKeys)
      parentObj.on(cb, filter)
  },

  untrackObject: async (pathKeys=[]) => {
    let parentObj = await gunDB.traverseDB(pathKeys)
    parentObj.off()
  },

  removeFromList: (pathKeys = []) => gunDB.updateObject(pathKeys, null)
}

export default gunDB