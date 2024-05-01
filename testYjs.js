import { Doc, WebrtcProvider } from "https://cdn.jsdelivr.net/gh/rozek/yjs-bundle/dist/yjs-bundle.esm.js"

let DEFAULT_SIGNALING_SERVER_URL = "wss://146ab835-4b6c-4d3e-b32f-c4c446dea5b6-00-25hgtara58a8t.spock.replit.dev:3000/"
let signalingServerURL = localStorage.signalingServerURL || ""
let ydoc = undefined
const DEFAULT_ROOM_NAME = "testing123"
const DEFAULT_ARRAY_NAME = "numbers"

const setupData = () => {
  const yArrayShared = ydoc.getArray(DEFAULT_ARRAY_NAME)
  yArrayShared.observeDeep((e) => {
    console.log(e)
    const currentArray = yArrayShared.toJSON()
    console.log("yarray updated: ", currentArray);
    const yjsArrayElement = document.getElementById("yjsArray")
    yjsArrayElement.querySelectorAll("li").forEach((childElement) => {
        yjsArrayElement.removeChild(childElement)
    })
    
    currentArray.forEach((val, index) => {
      const liElement = document.createElement("li")
      liElement.id = `yjsArray_li_${yjsArrayElement.childElementCount}`
      liElement.className = `yjsArray_li my-5`
      const inputElement = document.createElement("input")
      inputElement.id = `yjsArray_input_${yjsArrayElement.childElementCount}`
      inputElement.className = `yjsArray_input w-64 peer rounded border-0 bg-white px-3 py-3 outline-none transition-all duration-200 ease-linear focus:placeholder:opacity-900 peer-focus:text-primary data-[te-input-state-active]:placeholder:opacity-900 motion-reduce:transition-none dark:text-neutral-800 dark:placeholder:text-neutral-700 dark:peer-focus:text-primary`
      inputElement.type = "text"
      inputElement.value = val
      inputElement.onchange = () => {
        if (inputElement.value.length > 0) {
          updateDoc(index, "update", inputElement.value)
        }
      }
      const br = document.createElement("br")
      liElement.appendChild(inputElement)
      liElement.appendChild(br)
      yjsArrayElement.appendChild(liElement)
    })
  })
}

const updateDoc = (index, type="insert", val) => {
  const yArrayShared = ydoc.getArray(DEFAULT_ARRAY_NAME)
  switch(type) {
    case 'insert':
      yArrayShared.insert(index, [val])
      break
    case 'update':
      yArrayShared.delete(index, 1)
      yArrayShared.insert(index, [val])
      break
    case 'delete':
      yArrayShared.delete(index, 1)
      break
    default:
  }
}

const setupWebrtc = () => {
  ydoc = new Doc()

  const provider = new WebrtcProvider(DEFAULT_ROOM_NAME, ydoc, {
    signaling: [ signalingServerURL ]
  })

  provider.on('synced', synced => {
    console.log('synced!', synced)
  })
  
  setupData()
}

const setSignalingServer = (url) => {
  if (!url.startsWith("ws")) {
    if (url.startsWith("http")) {
      url = url.replace("https://", "")
      url = url.replace("http://", "")
    }
    url = url.includes("localhost") ? `ws://${url}` : `wss://${url}`
  }
  signalingServerURL = url
  localStorage.signalingServerURL = signalingServerURL
  if (document.getElementById("signalingServerURLInput").value !== signalingServerURL) {
    document.getElementById("signalingServerURLInput").value = signalingServerURL
  }
  setupWebrtc()
}

const addEventListeners = () => {
  const submitSignalingServerURLBtn = document.getElementById("signalingServerURLSubmit")
  submitSignalingServerURLBtn.onclick = () => {
    const signalingServerURLInput = document.getElementById("signalingServerURLInput")
    if (signalingServerURLInput.value.length > 0 && signalingServerURLInput.value !== signalingServerURL) {
      setSignalingServer(signalingServerURLInput.value)
    }
  }

  const useDefaultSignalingServerBtn = document.getElementById("useDefaultSignalingServerURL")
  useDefaultSignalingServerBtn.onclick = () => {
    const signalingServerURLInput = document.getElementById("signalingServerURLInput")
    setSignalingServer(DEFAULT_SIGNALING_SERVER_URL)
  }

  const addNewValueBtn = document.getElementById("addNewValue")
  addNewValueBtn.onclick = () => {
    const yjsArrayElement = document.getElementById("yjsArray")
    const liElement = document.createElement("li")
    liElement.className = `yjsArray_li my-5`
    const inputElement = document.createElement("input")
    // inputElement.id = `yjsArray_input_${yjsArrayElement.childElementCount}`
    inputElement.className = `yjsArray_input w-64 peer rounded border-0 bg-white px-3 py-3 outline-none transition-all duration-200 ease-linear focus:placeholder:opacity-900 peer-focus:text-primary data-[te-input-state-active]:placeholder:opacity-900 motion-reduce:transition-none dark:text-neutral-800 dark:placeholder:text-neutral-700 dark:peer-focus:text-primary`
    inputElement.type = "text"
    inputElement.onkeydown = (e) => {
      if (inputElement.value.length > 0 && e.key === 'Enter') {
        updateDoc(yjsArrayElement.childElementCount - 1, "insert", inputElement.value)
      }
    }
    const br = document.createElement("br")
    liElement.appendChild(inputElement)
    liElement.appendChild(br)
    yjsArrayElement.appendChild(liElement)
  }

}

window.onload = () => {
  addEventListeners()
}

// let yArrayShared
    

//     const provider = new WebrtcProvider("c4b", ydoc, {
//       signaling: [ "wss://d622301c-d02f-4801-8168-e9ea6beeb2ec-00-1ls86fnzcsyqq.riker.replit.dev/"]
//     })

//     provider.on('synced', synced => {
//         console.log('synced!', synced)
//     })

//     yArrayShared.observeDeep(() => {
//       console.log("yarray updated: ", yArrayShared.toJSON());
//     })

//     export const updateYArrayShared = (value) => {
//       yArrayShared.insert(0, value)
//     }
//     export const getYArrayShared = () => {
//       console.log(yArrayShared.toJSON())
//     }