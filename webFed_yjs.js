// import gunDB from './gunWrapper.js'
// import p2p from './yjsWrapper.js'

import { Doc, WebrtcProvider } from "https://cdn.jsdelivr.net/gh/rozek/yjs-bundle/dist/yjs-bundle.esm.js"
import * as tf from "https://esm.sh/@tensorflow/tfjs@4.20.0"

const TFJS_DEPENDENCY_URL = "https://esm.sh/@tensorflow/tfjs@4.20.0"
const TFJS_SAVED_MODELS_LOCALSTORAGE_PREFIX = "tensorflowjs_models"
const TFJS_MODEL_KEY_PREFIX_FOR_LOCALSTORAGE = "webFed"
const TFJS_MODEL_NAME = "model-1"
const TFJS_MODEL_KEYS_IN_LOCALSTORAGE = ["info", "model_metadata", "model_topology", "weight_data", "weight_specs"]

const DEFAULT_FEDERATION_NAME = "federation_x"
const PEERS_SHARED_ARRAY_NAME = "peers"
const MESSAGES_SHARED_ARRAY_NAME = "messages"
const PARAMETERS_SHARED_ARRAY_NAME = "PARAMETERS"

export class WebFed {
  constructor({signalingServer=[], federationName=DEFAULT_FEDERATION_NAME, federationPassword="", selfName, quorumThreshold=1.0}) {
    if (!signalingServer) {
      console.error("Please provide a valid URL to a signaling server.")
      return false
    }
    
    if (!selfName) {
      selfName = localStorage.webFed?.length > 0 ? JSON.parse(localStorage.webFed)?.selfName : window.crypto.randomUUID()
      localStorage.webFed = localStorage.webFed?.length > 0 ? JSON.stringify({
        ...JSON.parse(localStorage.webFed),
        selfName
      }) : JSON.stringify({
        selfName
      })
    }
    
    this.federationName = federationName
    this.selfName = selfName
    
    const signalingServerURLs = Array.isArray(signalingServer) ? signalingServer : [ signalingServer ]
    this.signalingServerURLs = signalingServerURLs.map(signalingServerURL => {
      if (!signalingServerURL.startsWith("ws")) {
        if (signalingServerURL.startsWith("http")) {
          signalingServerURL = signalingServerURL.replace("https://", "")
          signalingServerURL = signalingServerURL.replace("http://", "")
        }
        signalingServerURL = signalingServerURL.includes("localhost") ? `ws://${signalingServerURL}` : `wss://${signalingServerURL}`  
      }
      return signalingServerURL
    })
    
    this.yDoc = new Doc()
    this.peersSharedArray = this.yDoc.getArray(PEERS_SHARED_ARRAY_NAME)
    this.messagesSharedArray = this.yDoc.getArray(MESSAGES_SHARED_ARRAY_NAME)
    this.weightsSharedArray = this.yDoc.getArray(WEIGHTS_SHARED_ARRAY_NAME)

    this.provider = new WebrtcProvider(this.federationName, this.yDoc, {
      signaling: this.signalingServerURLs,
      password: federationPassword
    })
    
    this.provider.on('synced', (synced) => {
      const previousInstance = this.getPeerInfo(this.selfName)
      if (previousInstance) {
        const previousInstanceIndex = this.getAllPeers().findIndex(peerObj => peerObj.name === this.selfName)
        this.peersSharedArray.delete(previousInstanceIndex, 1)
      }
      this.peersSharedArray.push([{
        name: this.selfName,
        joinedAt: Date.now(),
        _webRTCPeerId: this.getSelfWebRTCPeerId()
      }])

      this.peersSharedArray.observeDeep((event) => {
        // Handle delta calculation later
        console.log(event)
        // console.log(event.changes.delta)
      })
      this.messagesSharedArray.observeDeep((event) => {
        this.messagesSharedArray.forEach(async (messageObj, index) => {
          if (!messageObj?.acknowledged?.includes(this.selfName)) {
            switch(messageObj.type) {
              case 'initialModelInfo':
                const modelData = messageObj.data
                Object.entries(modelData).forEach(([key, value]) => {
                  localStorage[key] = value
                })
                messageObj.acknowledged.push(this.selfName)
                this.messagesSharedArray.delete(index, 1)
                this.messagesSharedArray.insert(index, [messageObj])
                break
                
              case 'datasetParams': 
                const { datasetParams } = messageObj
                this.datasetParams = datasetParams
                messageObj.acknowledged.push(this.selfName)
                this.messagesSharedArray.delete(index, 1)
                this.messagesSharedArray.insert(index, [messageObj])
                break
                
              case 'modelInfoSent':
                this.model = await tf.loadLayersModel(`localstorage://${TFJS_MODEL_KEY_PREFIX_FOR_LOCALSTORAGE}/${TFJS_MODEL_NAME}`)
                messageObj.acknowledged.push(this.selfName)
                this.messagesSharedArray.delete(index, 1)
                this.messagesSharedArray.insert(index, [messageObj])
                if (messageObj.acknowledged.length === this.getNumPeers()*quorumThreshold) {
                  this.startTraining()
                }
                break
                
              case 'startTraining':
                const startTrainingEvent = new CustomEvent("startTraining")
                document.body.dispatchEvent(startTrainingEvent)
                messageObj.acknowledged.push(this.selfName)
                this.messagesSharedArray.delete(index, 1)
                this.messagesSharedArray.insert(index, [messageObj])
                break
            
              default:
                console.log(messageObj)
                break
            }
          }
        })
      })

    })

  }

  reset() {
    localStorage.clear()
    this.provider.disconnect()
  }

  isConnected() {
    return this.provider.connected
  }

  isSynced() {
    // Returns undefined if room has not yet been created
    return this.provider.room?.synced
  }

  getSignalingServerURLs() {
    return this.signalingServerURLs
  }

  getFederationName() {
    return this.federationName
  }

  getSelfWebRTCPeerId() {
    return this.provider.room?.peerId
  }

  getSelfName() {
    return this.selfName
  }

  getAllPeers() {
    const peers = []
    this.peersSharedArray.forEach(peerObj => {
      const peer = {
        ...peerObj,
        isSelf: peerObj.name === this.selfName && peerObj._webRTCPeerId === this.getSelfWebRTCPeerId()
      }
      peers.push(peer)
    })
    return peers
  }

  getNumPeers() {
    return this.getAllPeers().length
  }

  getPeerInfo(peerName) {
    const peerInfo = this.getAllPeers().find(peerObj => peerObj.name === peerName)
    return peerInfo
  }

  isPeerConnected(peerName) {
    const peerInfo = this.getPeerInfo(peerName)
    const isPeerConnected = this._isWebRTCPeerConnected(peerInfo._webRTCPeerId)
    return isPeerConnected
  }
  
  isPeerSynced(peerName) {
    const peerInfo = this.getPeerInfo(peerName)
    const isPeerSynced = this._isWebRTCPeerSynced(peerInfo._webRTCPeerId)
    return isPeerSynced
  }

  getConnectedPeers() {
    const connectedPeers = this.getAllPeers().filter(peerObj => !peerObj.isSelf && this.isPeerConnected(peerObj.name))
    return connectedPeers
  }
  
  getDisconnectedPeers() {
    const disconnectedPeers = this.getAllPeers().filter(peerObj => !peerObj.isSelf && !this.isPeerConnected(peerObj.name))
    return disconnectedPeers
  }
  
  getSyncedPeers() {
    const syncedPeers = this.getAllPeers().filter(peerObj => !peerObj.isSelf && this.isPeerSynced(peerObj.name))
    return syncedPeers
  }
  
  getDesyncedPeers() {
    const desyncedPeers = this.getAllPeers().filter(peerObj => !peerObj.isSelf && !this.isPeerSynced(peerObj.name))
    return desyncedPeers
  }
  
  sendMessageToPeer(peerName) {
    const { _webRTCPeerId } = this.getPeerInfo(peerName)
    if (_webRTCPeerId) {
      this._sendMessageToWebRTCPeer(_webRTCPeerId)
    }
  }

  expectMessageFromPeer(peerName, callback) {
    const { _webRTCPeerId } = this.getPeerInfo(peerName)
    this._expectMessageFromWebRTCPeer(_webRTCPeerId, callback)
  }

  broadcastMessage(message) {
    this.messagesSharedArray.push([message])
  }

  async initializeModel(model, shareWeights=false, datasetParams) {
    // Assumption that the model is TF.js for now.
    // const tfjs = await import(TFJS_DEPENDENCY_URL)
    this.model = model
    this.datasetParams = {
      dataset: datasetParams.dataset, 
      numEpochsToAggregateAfter: datasetParams.numEpochsToAggregateAfter || 5,
      aggregationStrategy: datasetParams.aggregationStrategy || 1,
      minIterations: datasetParams.minIterations || 10
    }

    const modelDataPrefixInLocalStorage = `${TFJS_MODEL_KEY_PREFIX_FOR_LOCALSTORAGE}/${TFJS_MODEL_NAME}`
    await model.save(`localstorage://${modelDataPrefixInLocalStorage}`)
    TFJS_MODEL_KEYS_IN_LOCALSTORAGE.forEach(key => {
      const keyInLocalStorage = Object.keys(localStorage).find(lsKey => lsKey.includes(`${modelDataPrefixInLocalStorage}/${key}`))
      const messageObj = {}
      messageObj[keyInLocalStorage] = localStorage[keyInLocalStorage]
      this.broadcastMessage({
        'type': "initialModelInfo",
        'data': messageObj,
        'acknowledged': [this.selfName]
      })
    })

    this.broadcastMessage({
      'type': "datasetParams",
      'datasetParams': {
        numEpochsToAggregateAfter: this.datasetParams.numEpochsToAggregateAfter,
        aggregationStrategy: this.datasetParams.aggregationStrategy,
        minIterations: this.datasetParams.minIterations
      },
      acknowledged: [this.selfName]
    })

    this.broadcastMessage({
      'type': "modelInfoSent",
      'acknowledged': [this.selfName]
    })
  }

  async startTraining() {    
    if (!modelInfoAcknowledgedByEnoughPeers) {
      console.error("Enough peers have not acknowledged receipt of model details. Please confirm and try again!")
      return false
    }

    this.broadcastMessage({
      'type': "startTraining",
      'acknowledged': [this.selfName]
    })

    this.model = this.model.compile()
    this.currentEpoch = 0
    this.historyMetrics = {
      'history': {
        'loss': [],
        'acc': []
      }
    }
    await this.runTrainingIteration()
    await this.aggregateWeights()

  }
  
  async runTrainingIteration() {
    const { trainingData, trainingLabels } = this.datasetParams.dataset
    for (let epoch = this.currentEpoch; epoch < this.datasetParams.numEpochsToAggregateAfter; epoch++) {
      console.log("Epoch", epoch)
      // for (let row in trainingData) {
      //   const gradientUpdate = await model.trainOnBatch(trainingData[row], trainingLabels[row])
      // }
      const gradientUpdate = await this.model.fit(trainingData, trainingLabels, {
        epochs: epoch+1,
        initialEpoch: epoch
      })
      this.historyMetrics.history.loss.push(gradientUpdate.history.loss)
      this.historyMetrics.history.acc.push(gradientUpdate.history.acc)
    }
    return
  }

  async aggregateWeights() {

  }

  _isWebRTCPeerConnected(webRTCPeerId) {
    return this.provider.room?.webrtcConns.get(webRTCPeerId)?.connected
  }
  
  _isWebRTCPeerSynced(webRTCPeerId) {
    return this.provider.room?.webrtcConns.get(webRTCPeerId)?.synced
  }

  _getAllWebRTCPeerIds() {
    const WebRTCpeerIds = []
    this.provider.room?.webrtcConns.keys().forEach(WebRTCpeerId => WebRTCpeerIds.push(WebRTCpeerId))
    return WebRTCpeerIds
  }

  _getNumberOfWebRTCPeers() {
    return (this.getAllWebRTCPeerIds()).length
  }

  _getConnectedWebRTCPeers() {
    const connectedWebRTCPeerIds = []
    this.provider.room?.webrtcConns.entries().forEach(([key, value]) => {
      if (value.connected) {
        connectedWebRTCPeerIds.push(key)
      }
    })
    return connectedWebRTCPeerIds
  }
  
  _getDisconnectedWebRTCPeers() {
    const disconnectedWebRTCPeerIds = []
    this.provider.room?.webrtcConns.entries().forEach(([key, value]) => {
      if (!value.connected) {
        disconnectedWebRTCPeerIds.push(key)
      }
    })
    return disconnectedWebRTCPeerIds
  }
  
  _getSyncedWebRTCPeers() {
    const synced = []
    this.provider.room?.webrtcConns.entries().forEach(([key, value]) => {
      if (value.synced) {
        synced.push(key)
      }
    })
    return synced
  }

  _sendMessageToWebRTCPeer(webRTCPeerId, message) {
    this.provider.room?.webrtcConns.get(webRTCPeerId)?.peer.send(message)
  }
  
  _expectMessageFromWebRTCPeer(webRTCPeerId, callback) {
    this.provider.room?.webrtcConns.get(webRTCPeerId)?.peer.on('data', callback)
  }

}

// export default webFed

// const configuration = { 'iceServers': [{ 'urls': 'stun:stun.l.google.com:19302' }] }
// const GUN_TLN_KEY = "federatedTest"
// const GUN_KEYS_SPEC = {
//   config: 'config',
//   users: 'users',
//   fedDetails: 'federationDetails',
//   modelUpdates: 'modelUpdates'
// }

// const webFed = {}
// webFed.currentFederation = {
//   id: '',
//   clients: {}
// }
// webFed.allFederationIds = []

// webFed.isFederation = (federationId=webFed.currentFederation.id) => webFed.allFederationIds.includes(federationId)

// webFed.getClientInfo = async (federationId=webFed.currentFederation.id, clientId) => {
//   if (webFed.isFederation(federationId)) {
//     return await gunDB.getObject([GUN_TLN_KEY, federationId, clientId])
//   }
// }

// webFed.isClientInFederation = async (federationId=webFed.currentFederation.id, clientId) => {
//   return !!(await webFed.getClientInfo(federationId, clientId))
// }

// webFed.updateAllClientsList = async (federationId=webFed.currentFederation.id, selfClientId) => {
//   if (webFed.isFederation(federationId)) {
//     const allClients = await gunDB.getObject([GUN_TLN_KEY,federationId, GUN_KEYS_SPEC['users']])
//     if (allClients) {
//       Object.keys(allClients).filter(clientId => !webFed.currentFederation?.clients?.[clientId]).forEach(clientId => {
//         webFed.currentFederation.clients[clientId] = {
//           'id': clientId,
//           'connectionState': clientId !== selfClientId ? "disconnected" : ""
//         }
//       })
//     }
//   }
// }

// webFed.getAllPeers = (federationId=webFed.currentFederation.id, selfClientId) => Object.keys(webFed.currentFederation.clients).reduce((peers, clientId)  => {
//   if (clientId !== selfClientId) {
//     peers[clientId] = webFed.currentFederation.clients[clientId]
//   }
//   return peers
// }, {})

// webFed.getConnectedPeers = async(federationId=webFed.currentFederation.id, selfClientId) => {
//   const peers = await webFed.getAllPeers(federationId, selfClientId)
//   const connectedPeers = Object.keys(peers).reduce((newPeerIds, peerId) => {
//     if (peers[peerId].connectionState === "connected") {
//       newPeerIds.push(peerId)
//     }
//     return newPeerIds
//   }, [])
//   return connectedPeers
// }

// webFed.getDisconnectedPeers = async (federationId=webFed.currentFederation.id, selfClientId) => {
//   const peers = await webFed.getAllPeers(federationId, selfClientId)
//   const disconnectedPeers = Object.keys(peers).reduce((newPeerIds, peerId) => {
//     if (peers[peerId].connectionState === "disconnected") {
//       newPeerIds.push(peerId)
//     }
//     return newPeerIds
//   }, [])
//   return disconnectedPeers
// }

// webFed.getAllFederationIds = () => {
//   console.warn("Multiple federations not yet supported")
//   return webFed.allFederationIds
// }

// webFed.getFederation = async (federationId) => {
//   console.warn("Multiple federations not yet supported")
//   return await gunDB.getObject([GUN_TLN_KEY, GUN_KEYS_SPEC.fedDetails, federationId])
// }

// webFed.createFederation = async (newFederationId, description='') => {
//   const federationId = newFederationId || crypto.randomUUID()
  
//   if (webFed.allFederationIds.includes(federationId)) {
//     console.error("Federation already exists!")
//     return
//   } else {
//     const federationObject = {
//       federationId,
//       description
//     }
    
//     try {
//       await gunDB.createObject([GUN_TLN_KEY, GUN_KEYS_SPEC['fedDetails']], federationId, federationObject) // Create a key to maintain federation specifics/details
//       await gunDB.createObject([GUN_TLN_KEY], federationId) // Create a key to add users into the federation
//       webFed.allFederationIds.push(federationId)
//       console.log(`Federation created with ID: ${federationId}`)
//       return federationId
//     } catch(e) {
//       console.error("Error occurred while creating federation:", e)
//       return undefined
//     }
//   }
// }

// webFed.joinFederation = async (federationId, clientId) => {
//   if (!federationId || !webFed.isFederation(federationId)) {
//     const errorMsg = "Parameter federationId missing or incorrect!"
//     console.error(errorMsg)
//     return errorMsg
//   }
//   if (!clientId) {
//     const errorMsg = "Parameter clientId missing or incorrect!"
//     console.error(errorMsg)
//     return errorMsg
//   }
//   const selfJoinedTime = Date.now()
  
//   if (!(await webFed.isClientInFederation(federationId, clientId))) {
//     const clientIdRecord = await gunDB.createObject([GUN_TLN_KEY, federationId], clientId, clientId)
//     const clientJoinedTimeRecord = await gunDB.createObject([GUN_TLN_KEY, federationId, clientId], "joinedTime", selfJoinedTime)
//     const clientFederationId = await gunDB.createObject([GUN_TLN_KEY, federationId, clientId], "federationId", federationId)
//   }
  
//   const clientRecordInUsers = await gunDB.createObject([GUN_TLN_KEY, federationId, GUN_KEYS_SPEC.users], clientId, selfJoinedTime)
  
//   if (webFed.currentFederation?.id) {
//     await gunDB.untrackObject([GUN_TLN_KEY, webFed.currentFederation.id, GUN_KEYS_SPEC['users']])
//   }
//   webFed.currentFederation.id = federationId

//   const refreshPeerConnectionsFromDB = (newClients) => {
//     if (newClients) {
//       const {_, ...newPeers} = newClients
//       const peersToBeConnectedWith = Object.keys(newPeers).filter(peerId => peerId !== clientId && !webFed.currentFederation.clients[peerId]) 
//       if (peersToBeConnectedWith.length > 0) {
//         peersToBeConnectedWith.forEach(async (peerId) => {
//           await webFed.updateAllClientsList(federationId, clientId)
//           webFed.connectToPeer(webFed.currentFederation.id, clientId, peerId)
//         })
//       }
//     }
//   }
//   await gunDB.trackObject([GUN_TLN_KEY, webFed.currentFederation.id, GUN_KEYS_SPEC['users']], refreshPeerConnectionsFromDB, true)
//   await webFed.connectToPeers(federationId, clientId)

//   return federationId
// }

// webFed.connectToPeers = async (federationId=webFed.currentFederation.id, selfClientId) => {
//   await webFed.updateAllClientsList(federationId, selfClientId)

//   const newPeers = await webFed.getDisconnectedPeers(federationId, selfClientId)

//   newPeers.forEach(async (peerId) => {
//     webFed.connectToPeer(federationId, selfClientId, peerId)
    
//   })
// }

// webFed.connectToPeer = async (federationId=webFed.currentFederation.id, selfClientId, peerId, peerProperties = undefined) => {
//   const createOffer = async (peerId) => {
//     console.log("Creating Offer")
//     webFed.currentFederation.clients[peerId].localConnection = new RTCPeerConnection(configuration)
//     webFed.currentFederation.clients[peerId].localConnection.onsignalingstatechange = (e) => {
//       console.log("Local signaling state change:\n", e.currentTarget.signalingState)
//     }
//     webFed.currentFederation.clients[peerId].localConnection.onicegatheringstatechange = (e) => {
//       console.log("Local ICE gathering state change:\n", e.currentTarget.iceGatheringState)
//     }
//     webFed.currentFederation.clients[peerId].localConnection.oniceconnectionstatechange = (e) => {
//       console.log("Local signaling state change:\n", e.currentTarget.iceConnectionState)
//     }
//     webFed.currentFederation.clients[peerId].localConnection.onicecandidate = (e) => console.log("New ICE Candidate", e.candidate)
//     // webFed.currentFederation.clients[peerId].localConnection.onicecandidateerror = console.error
  
//     webFed.currentFederation.clients[peerId].dataChannel = webFed.currentFederation.clients[peerId].localConnection.createDataChannel("channel");
    
//     await new Promise(resolve => setTimeout(resolve, 1000))
//     const offer = await webFed.currentFederation.clients[peerId].localConnection.createOffer();
//     await webFed.currentFederation.clients[peerId].localConnection.setLocalDescription(offer);
//     // webFed.currentFederation.clients[peerId].localConnection = localConnection
//     // webFed.currentFederation.clients[peerId].dataChannel = dataChannel
    
//     return JSON.parse(JSON.stringify(webFed.currentFederation.clients[peerId].localConnection.localDescription))
//   }
  
//   const createAnswer = async (offer, peerId) => {
//     let answer = undefined
//     console.log("Creating Answer")
//     webFed.currentFederation.clients[peerId].remoteConnection = new RTCPeerConnection(configuration)
//     webFed.currentFederation.clients[peerId].remoteConnection.onsignalingstatechange = (e) => console.log("Remote signaling state change:\n", e.currentTarget.signalingState)
//     webFed.currentFederation.clients[peerId].remoteConnection.onicegatheringstatechange = (e) => {
//       console.log("Remote ICE gathering state change:\n", e.currentTarget.iceGatheringState)
//     }
//     webFed.currentFederation.clients[peerId].remoteConnection.oniceconnectionstatechange = (e) => {
//       console.log("Remote signaling state change:\n", e.currentTarget.iceConnectionState)
//     }
//     webFed.currentFederation.clients[peerId].remoteConnection.onicecandidate = (e) => console.log("New ICE Candidate", e.candidate)
    
//     if (!webFed.currentFederation.clients[peerId].remoteConnection.remoteDescription) {
//       await webFed.currentFederation.clients[peerId].remoteConnection.setRemoteDescription(offer)
//       await new Promise(resolve => setTimeout(resolve, 1000))
//       answer = await webFed.currentFederation.clients[peerId].remoteConnection.createAnswer()
//       await webFed.currentFederation.clients[peerId].remoteConnection.setLocalDescription(answer)
//       await new Promise(resolve => setTimeout(resolve, 1000))
//       // webFed.currentFederation.clients[peerId].remoteConnection = remoteConnection
//     }
    
//     return JSON.parse(JSON.stringify(webFed.currentFederation.clients[peerId].remoteConnection.localDescription))
//   }
  
//   const selfJoinedTime = await gunDB.getObject([GUN_TLN_KEY, federationId, selfClientId, "joinedTime"])
//   let peerJoinedTime = await gunDB.getObject([GUN_TLN_KEY, federationId, peerId, "joinedTime"])

//   // HACK: peerJoinedTime sometimes doesn't get returned, no idea why. For now, get it from the users key as a workaround.
//   if (!peerJoinedTime) {
//     peerJoinedTime = await gunDB.getObject([GUN_TLN_KEY, federationId, GUN_KEYS_SPEC['users'], peerId])
//   }

//   if (webFed.currentFederation.clients[peerId].connectionState === "disconnected") {
//     webFed.currentFederation.clients[peerId].connectionState = "attempting"
    
//     document.dispatchEvent(new CustomEvent('newPeer', {
//       detail: {
//         peerId
//       }
//     }))
    
//     if (selfJoinedTime < peerJoinedTime) {
//       // If peer joined later, create an offer and wait to receive an answer.
//       gunDB.trackObject([GUN_TLN_KEY, federationId, peerId, "answers", selfClientId], (answer) => {
//         // const answer = await mnist.getFromObjectProps(peerId, `answer/${localStorage.clientId}`)
        
//         if (answer && webFed.currentFederation.clients[peerId].connectionState !== "receiving_answer") {
//           webFed.currentFederation.clients[peerId].connectionState = "receiving_answer"
//           webFed.currentFederation.clients[peerId].dataChannel.onopen = (e) => {
//             webFed.currentFederation.clients[peerId].connectionState = "connected"
//             document.dispatchEvent(new CustomEvent('peerConnected', {
//               detail: {
//                 peerId
//               }
//             }))
            
//             gunDB.untrackObject([GUN_TLN_KEY, federationId, peerId, "answers", selfClientId])
//             gunDB.updateObject([GUN_TLN_KEY, federationId, selfClientId, "offers", peerId], null)
//           }
          
//           // webFed.currentFederation.clients[peerId].dataChannel.onmessage = (msg) => console.log("Received data from peer:\n", msg.data)
          
//           if (!webFed.currentFederation.clients[peerId].localConnection.remoteDescription) {
//             setTimeout(() => webFed.currentFederation.clients[peerId].localConnection.setRemoteDescription(answer), 1000)
//             console.log("Remote description set")
//           }
          
//         }
//       }, true)
      
//       const offer = await createOffer(peerId)
//       webFed.currentFederation.clients[peerId].connectionState = "offer"
//       // const offerObj = gun.get(peerId).put(offer)
      
//       await gunDB.createObject([GUN_TLN_KEY, federationId, selfClientId, "offers"], peerId, offer)
      
//     } else {
//       gunDB.trackObject([GUN_TLN_KEY, federationId, peerId, "offers", selfClientId], async (offer) => {
//         // const offer = await mnist.getFromObjectProps(peerId, `offer/${localStorage.clientId}`)
//         if (offer && webFed.currentFederation.clients[peerId].connectionState != "answering") {
//           webFed.currentFederation.clients[peerId].connectionState = "answering"
          
//           const answer = await createAnswer(offer, peerId)
//           webFed.currentFederation.clients[peerId].remoteConnection.ondatachannel = (e) => {
//             webFed.currentFederation.clients[peerId].dataChannel = e.channel
//             webFed.currentFederation.clients[peerId].dataChannel.onopen = (e) => {
//               webFed.currentFederation.clients[peerId].connectionState = "connected"
//               document.dispatchEvent(new CustomEvent('peerConnected', {
//                 detail: {
//                   peerId
//                 }
//               }))
//               gunDB.untrackObject([GUN_TLN_KEY, federationId, peerId, "offers", selfClientId])
//               gunDB.updateObject([GUN_TLN_KEY, federationId, selfClientId, "answers", peerId], null)
//             }
            
//             // webFed.currentFederation.clients[peerId].dataChannel.onmessage = (msg) => {
//             //   console.log("msg from peer:", msg)
//             // }
//           }
//           gunDB.createObject([GUN_TLN_KEY, federationId, selfClientId, "answers"], peerId, answer)
//         }
//       }, true)
//     }
    
//   }
    
// }

// webFed.sendDataToPeer = (peerId, data) => {
//   if (typeof(data) === 'object') {
//     data = JSON.stringify(data)
//   }
//   webFed.currentFederation.clients[peerId].dataChannel.send(data)
// }

// webFed.broadcastToAllPeers = async (federationId, clientId, data) => {
//   if (typeof(data) === 'object') {
//     data = JSON.stringify(data)
//   }
//   const peersCommunicated = []
//   const allPeers = await webFed.getAllPeers(federationId, clientId)
//   Object.values(allPeers).forEach(peer => {
//     if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
//       peer.dataChannel.send(data)
//       peersCommunicated.push(peer.id)
//     }
//   })
//   return peersCommunicated
// }

// webFed.sendDataToPeer = (peerId, data) => {
//   p2p.sendDataToPeer(peerId, data)
// }

// webFed.broadcastData = (data) => {
//   p2p.broadcastData(data)
// }

// webFed.listenForMessageFromPeer = (peerId, cb, once=true) =>
//   webFed.currentFederation.clients[peerId].dataChannel.addEventListener("message", cb, {
//     once
//   })

// webFed.initializeFederation = async (initOptions) => {
//   const { clientId: connectedClientId, federationId: connectedFederationId } = await p2p.initializeFederation(initOptions)
//   webFed.group = p2p.group
//   // if (!gunServerPath) {
//   //   console.error("Path to Gun server required")
//   // }
//   // if (!clientId) {
//   //   clientId = crypto.randomUUID()
//   // }
//   // gunDB.initialize(gunServerPath)
  
//   // const refreshFederationsFromDB = async () => {
//   //   const allFederations = await gunDB.getObject([GUN_TLN_KEY, GUN_KEYS_SPEC['fedDetails']])
    
//   //   if (allFederations && !Object.keys(allFederations).every((fed, ind) => fed === webFed.allFederationIds[ind])) {
//   //     webFed.allFederationIds = Object.keys(allFederations)
      
//   //     if (currentFederationId) {
//   //       await webFed.updateAllClientsList(currentFederationId, clientId)
//   //       if (webFed.currentFederation.clients?.[clientId] && webFed.currentFederation.id !== currentFederationId) {
          
//   //         if (webFed.currentFederation.id) {
//   //           gunDB.untrackObject([GUN_TLN_KEY, webFed.currentFederation.id, GUN_KEYS_SPEC['users']])
//   //         }
          
//   //         webFed.currentFederation.id = currentFederationId

//   //       } else {
//   //         currentFederationId = undefined
//   //       }
//   //     }
//   //     document.dispatchEvent(new CustomEvent('federationsChanged'))
//   //   }
//   // }
  
//   // await refreshFederationsFromDB()
//   // gunDB.trackObject([GUN_TLN_KEY, GUN_KEYS_SPEC['fedDetails']], refreshFederationsFromDB)
  
//   return { connectedClientId, connectedFederationId }
// }