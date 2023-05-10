import gunDB from './gunWrapper.js'


const configuration = { 'iceServers': [{ 'urls': 'stun:stun.l.google.com:19302' }] }
const GUN_TLN_KEY = "federatedTest"
const GUN_KEYS_SPEC = {
  config: 'config',
  users: 'users',
  fedDetails: 'federationDetails',
  modelUpdates: 'modelUpdates'
}

const webFed = {}
webFed.currentFederation = {
  id: '',
  clients: {}
}
webFed.allFederationIds = []


webFed.isFederation = (federationId=webFed.currentFederation.id) => webFed.allFederationIds.includes(federationId)

webFed.getClientInfo = async (federationId=webFed.currentFederation.id, clientId) => {
  if (webFed.isFederation(federationId)) {
    return await gunDB.getObject([GUN_TLN_KEY, federationId, clientId])
  }
}

webFed.isClientInFederation = async (federationId=webFed.currentFederation.id, clientId) => {
  return !!(await webFed.getClientInfo(federationId, clientId))
}

webFed.updateAllClientsList = async (federationId=webFed.currentFederation.id, selfClientId) => {
  if (webFed.isFederation(federationId)) {
    const allClients = await gunDB.getObject([GUN_TLN_KEY,federationId, GUN_KEYS_SPEC['users']])
    if (allClients) {
      Object.keys(allClients).filter(clientId => !webFed.currentFederation?.clients?.[clientId]).forEach(clientId => {
        webFed.currentFederation.clients[clientId] = {
          'id': clientId,
          'connectionState': clientId !== selfClientId ? "disconnected" : ""
        }
      })
    }
  }
}

webFed.getAllPeers = (federationId=webFed.currentFederation.id, selfClientId) => Object.keys(webFed.currentFederation.clients).reduce((peers, clientId)  => {
  if (clientId !== selfClientId) {
    peers[clientId] = webFed.currentFederation.clients[clientId]
  }
  return peers
}, {})

webFed.getConnectedPeers = async(federationId=webFed.currentFederation.id, selfClientId) => {
  const peers = await webFed.getAllPeers(federationId, selfClientId)
  const connectedPeers = Object.keys(peers).reduce((newPeerIds, peerId) => {
    if (peers[peerId].connectionState === "connected") {
      newPeerIds.push(peerId)
    }
    return newPeerIds
  }, [])
  return connectedPeers
}

webFed.getDisconnectedPeers = async (federationId=webFed.currentFederation.id, selfClientId) => {
  const peers = await webFed.getAllPeers(federationId, selfClientId)
  const disconnectedPeers = Object.keys(peers).reduce((newPeerIds, peerId) => {
    if (peers[peerId].connectionState === "disconnected") {
      newPeerIds.push(peerId)
    }
    return newPeerIds
  }, [])
  return disconnectedPeers
}

webFed.getAllFederationIds = () => {
  console.warn("Multiple federations not yet supported")
  return webFed.allFederationIds
}

// webFed.getAllFederationIds = async () => {
//   console.warn("Multiple federations not yet supported")
//   return await gunDB.getObject([GUN_TLN_KEY, GUN_KEYS_SPEC.fedDetails])
// }

webFed.getFederation = async (federationId) => {
  console.warn("Multiple federations not yet supported")
  return await gunDB.getObject([GUN_TLN_KEY, GUN_KEYS_SPEC.fedDetails, federationId])
}

webFed.createFederation = async (newFederationId, description='') => {
  const federationId = newFederationId || crypto.randomUUID()
  
  if (webFed.allFederationIds.includes(federationId)) {
    console.error("Federation already exists!")
    return
  } else {
    const federationObject = {
      federationId,
      description
    }
    
    try {
      await gunDB.createObject([GUN_TLN_KEY, GUN_KEYS_SPEC['fedDetails']], federationId, federationObject) // Create a key to maintain federation specifics/details
      await gunDB.createObject([GUN_TLN_KEY], federationId) // Create a key to add users into the federation
      webFed.allFederationIds.push(federationId)
      console.log(`Federation created with ID: ${federationId}`)
      return federationId
    } catch(e) {
      console.error("Error occurred while creating federation:", e)
      return undefined
    }
  }
}

webFed.joinFederation = async (federationId, clientId) => {
  if (!federationId || !webFed.isFederation(federationId)) {
    const errorMsg = "Parameter federationId missing or incorrect!"
    console.error(errorMsg)
    return errorMsg
  }
  if (!clientId) {
    const errorMsg = "Parameter clientId missing or incorrect!"
    console.error(errorMsg)
    return errorMsg
  }
  const selfJoinedTime = Date.now()
  
  if (!(await webFed.isClientInFederation(federationId, clientId))) {
    const clientIdRecord = await gunDB.createObject([GUN_TLN_KEY, federationId], clientId, clientId)
    const clientJoinedTimeRecord = await gunDB.createObject([GUN_TLN_KEY, federationId, clientId], "joinedTime", selfJoinedTime)
    const clientFederationId = await gunDB.createObject([GUN_TLN_KEY, federationId, clientId], "federationId", federationId)
  }
  
  const clientRecordInUsers = await gunDB.createObject([GUN_TLN_KEY, federationId, GUN_KEYS_SPEC.users], clientId, selfJoinedTime)
  
  if (webFed.currentFederation?.id) {
    await gunDB.untrackObject([GUN_TLN_KEY, webFed.currentFederation.id, GUN_KEYS_SPEC['users']])
  }
  webFed.currentFederation.id = federationId

  const refreshPeerConnectionsFromDB = (newClients) => {
    if (newClients) {
      const {_, ...newPeers} = newClients
      const peersToBeConnectedWith = Object.keys(newPeers).filter(peerId => peerId !== clientId && !webFed.currentFederation.clients[peerId]) 
      if (peersToBeConnectedWith.length > 0) {
        peersToBeConnectedWith.forEach(async (peerId) => {
          await webFed.updateAllClientsList(federationId, clientId)
          webFed.connectToPeer(webFed.currentFederation.id, clientId, peerId)
        })
      }
    }
  }
  await gunDB.trackObject([GUN_TLN_KEY, webFed.currentFederation.id, GUN_KEYS_SPEC['users']], refreshPeerConnectionsFromDB, true)
  await webFed.connectToPeers(federationId, clientId)

  return federationId
}

webFed.connectToPeers = async (federationId=webFed.currentFederation.id, selfClientId) => {
  await webFed.updateAllClientsList(federationId, selfClientId)

  const newPeers = await webFed.getDisconnectedPeers(federationId, selfClientId)

  newPeers.forEach(async (peerId) => {
    webFed.connectToPeer(federationId, selfClientId, peerId)
    
  })
}

webFed.connectToPeer = async (federationId=webFed.currentFederation.id, selfClientId, peerId, peerProperties = undefined) => {
  const createOffer = async (peerId) => {
    console.log("Creating Offer")
    webFed.currentFederation.clients[peerId].localConnection = new RTCPeerConnection(configuration)
    webFed.currentFederation.clients[peerId].localConnection.onsignalingstatechange = (e) => {
      console.log("Local signaling state change:\n", e.currentTarget.signalingState)
    }
    webFed.currentFederation.clients[peerId].localConnection.onicegatheringstatechange = (e) => {
      console.log("Local ICE gathering state change:\n", e.currentTarget.iceGatheringState)
    }
    webFed.currentFederation.clients[peerId].localConnection.oniceconnectionstatechange = (e) => {
      console.log("Local signaling state change:\n", e.currentTarget.iceConnectionState)
    }
    webFed.currentFederation.clients[peerId].localConnection.onicecandidate = (e) => console.log("New ICE Candidate", e.candidate)
    // webFed.currentFederation.clients[peerId].localConnection.onicecandidateerror = console.error
  
    webFed.currentFederation.clients[peerId].dataChannel = webFed.currentFederation.clients[peerId].localConnection.createDataChannel("channel");
    
    await new Promise(resolve => setTimeout(resolve, 1000))
    const offer = await webFed.currentFederation.clients[peerId].localConnection.createOffer();
    await webFed.currentFederation.clients[peerId].localConnection.setLocalDescription(offer);
    // webFed.currentFederation.clients[peerId].localConnection = localConnection
    // webFed.currentFederation.clients[peerId].dataChannel = dataChannel
    
    return JSON.parse(JSON.stringify(webFed.currentFederation.clients[peerId].localConnection.localDescription))
  }
  
  const createAnswer = async (offer, peerId) => {
    let answer = undefined
    console.log("Creating Answer")
    webFed.currentFederation.clients[peerId].remoteConnection = new RTCPeerConnection(configuration)
    webFed.currentFederation.clients[peerId].remoteConnection.onsignalingstatechange = (e) => console.log("Remote signaling state change:\n", e.currentTarget.signalingState)
    webFed.currentFederation.clients[peerId].remoteConnection.onicegatheringstatechange = (e) => {
      console.log("Remote ICE gathering state change:\n", e.currentTarget.iceGatheringState)
    }
    webFed.currentFederation.clients[peerId].remoteConnection.oniceconnectionstatechange = (e) => {
      console.log("Remote signaling state change:\n", e.currentTarget.iceConnectionState)
    }
    webFed.currentFederation.clients[peerId].remoteConnection.onicecandidate = (e) => console.log("New ICE Candidate", e.candidate)
    
    if (!webFed.currentFederation.clients[peerId].remoteConnection.remoteDescription) {
      await webFed.currentFederation.clients[peerId].remoteConnection.setRemoteDescription(offer)
      await new Promise(resolve => setTimeout(resolve, 1000))
      answer = await webFed.currentFederation.clients[peerId].remoteConnection.createAnswer()
      await webFed.currentFederation.clients[peerId].remoteConnection.setLocalDescription(answer)
      await new Promise(resolve => setTimeout(resolve, 1000))
      // webFed.currentFederation.clients[peerId].remoteConnection = remoteConnection
    }
    
    return JSON.parse(JSON.stringify(webFed.currentFederation.clients[peerId].remoteConnection.localDescription))
  }
  
  const selfJoinedTime = await gunDB.getObject([GUN_TLN_KEY, federationId, selfClientId, "joinedTime"])
  let peerJoinedTime = await gunDB.getObject([GUN_TLN_KEY, federationId, peerId, "joinedTime"])

  // HACK: peerJoinedTime sometimes doesn't get returned, no idea why. For now, get it from the users key as a workaround.
  if (!peerJoinedTime) {
    peerJoinedTime = await gunDB.getObject([GUN_TLN_KEY, federationId, GUN_KEYS_SPEC['users'], peerId])
  }

  if (webFed.currentFederation.clients[peerId].connectionState === "disconnected") {
    webFed.currentFederation.clients[peerId].connectionState = "attempting"
    
    document.dispatchEvent(new CustomEvent('newPeer', {
      detail: {
        peerId
      }
    }))
    
    if (selfJoinedTime < peerJoinedTime) {
      // If peer joined later, create an offer and wait to receive an answer.
      gunDB.trackObject([GUN_TLN_KEY, federationId, peerId, "answers", selfClientId], (answer) => {
        // const answer = await mnist.getFromObjectProps(peerId, `answer/${localStorage.clientId}`)
        
        if (answer && !webFed.currentFederation.clients[peerId].connectionState !== "receiving_answer") {
          webFed.currentFederation.clients[peerId].connectionState = "receiving_answer"
          webFed.currentFederation.clients[peerId].dataChannel.onopen = (e) => {
            webFed.currentFederation.clients[peerId].connectionState = "connected"
            document.dispatchEvent(new CustomEvent('peerConnected', {
              detail: {
                peerId
              }
            }))
            
            gunDB.untrackObject([GUN_TLN_KEY, federationId, peerId, "answers", selfClientId])
            gunDB.updateObject([GUN_TLN_KEY, federationId, selfClientId, "offers", peerId], null)
          }
          
          webFed.currentFederation.clients[peerId].dataChannel.onmessage = (msg) => console.log("Received data from peer:\n", msg.data)
          
          if (!webFed.currentFederation.clients[peerId].localConnection.remoteDescription) {
            setTimeout(() => webFed.currentFederation.clients[peerId].localConnection.setRemoteDescription(answer), 1000)
            console.log("Remote description set")
          }
          
        }
      }, true)
      
      const offer = await createOffer(peerId)
      webFed.currentFederation.clients[peerId].connectionState = "offer"
      // const offerObj = gun.get(peerId).put(offer)
      
      await gunDB.createObject([GUN_TLN_KEY, federationId, selfClientId, "offers"], peerId, offer)
      
    } else {
      gunDB.trackObject([GUN_TLN_KEY, federationId, peerId, "offers", selfClientId], async (offer) => {
        // const offer = await mnist.getFromObjectProps(peerId, `offer/${localStorage.clientId}`)
        if (offer && webFed.currentFederation.clients[peerId].connectionState != "answering") {
          webFed.currentFederation.clients[peerId].connectionState = "answering"
          
          const answer = await createAnswer(offer, peerId)
          webFed.currentFederation.clients[peerId].remoteConnection.ondatachannel = (e) => {
            webFed.currentFederation.clients[peerId].dataChannel = e.channel
            webFed.currentFederation.clients[peerId].dataChannel.onopen = (e) => {
              webFed.currentFederation.clients[peerId].connectionState = "connected"
              document.dispatchEvent(new CustomEvent('peerConnected', {
                detail: {
                  peerId
                }
              }))
              gunDB.untrackObject([GUN_TLN_KEY, federationId, peerId, "offers", selfClientId])
              gunDB.updateObject([GUN_TLN_KEY, federationId, selfClientId, "answers", peerId], null)
            }
            
            webFed.currentFederation.clients[peerId].dataChannel.onmessage = (msg) => {
              console.log("msg from peer:", msg)
            }
          }
          gunDB.createObject([GUN_TLN_KEY, federationId, selfClientId, "answers"], peerId, answer)
        }
      }, true)
    }
    
  }
    
}

webFed.sendDataToPeer = (peerId, data) => {
  if (typeof(data) === 'object') {
    data = JSON.stringify(data)
  }
  webFed.currentFederation.clients[peerId].dataChannel.send(data)
}

webFed.broadcastToAllPeers = async (federationId, clientId, data) => {
  if (typeof(data) === 'object') {
    data = JSON.stringify(data)
  }
  const peersCommunicated = []
  const allPeers = await webFed.getAllPeers(federationId, clientId)
  Object.values(allPeers).forEach(peer => {
    if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
      peer.dataChannel.send(data)
      peersCommunicated.push(peer)
    }
  })
  return peersCommunicated
}

webFed.listenForMessageFromPeer = (peerId, cb, once=true) => {
  console.log(webFed.currentFederation.clients)
  webFed.currentFederation.clients[peerId].dataChannel.addEventListener("message", cb, {
    once
  })
}

webFed.initialize = async (gunServerPath, clientId, currentFederationId) => {
  if (!gunServerPath) {
    console.error("Path to Gun server required")
  }
  if (!clientId) {
    clientId = crypto.randomUUID()
  }
  gunDB.initialize(gunServerPath)
  
  const refreshFederationsFromDB = async () => {
    const allFederations = await gunDB.getObject([GUN_TLN_KEY, GUN_KEYS_SPEC['fedDetails']])
    
    if (allFederations && !Object.keys(allFederations).every((fed, ind) => fed === webFed.allFederationIds[ind])) {
      webFed.allFederationIds = Object.keys(allFederations)
      
      if (currentFederationId) {
        await webFed.updateAllClientsList(currentFederationId, clientId)
        if (webFed.currentFederation.clients?.[clientId] && webFed.currentFederation.id !== currentFederationId) {
          
          if (webFed.currentFederation.id) {
            gunDB.untrackObject([GUN_TLN_KEY, webFed.currentFederation.id, GUN_KEYS_SPEC['users']])
          }
          
          webFed.currentFederation.id = currentFederationId

        } else {
          currentFederationId = undefined
        }
      }
      document.dispatchEvent(new CustomEvent('federationsChanged'))
    }
  }
  
  await refreshFederationsFromDB()
  gunDB.trackObject([GUN_TLN_KEY, GUN_KEYS_SPEC['fedDetails']], refreshFederationsFromDB)
  
  return { clientId, currentFederationId }
}

export default webFed