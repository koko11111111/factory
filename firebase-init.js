// ============================================================================
// Handles: one shared password for the whole workshop (no email shown to the
// user anywhere), and syncing app data across devices via Firestore.
//
// How the "password only, no email" trick works:
// Firebase Auth's email/password sign-in needs *an* email internally, but
// nothing says the user has to see or choose it. We use one fixed, made-up
// email tied to your Firebase project, and the password the user picks
// becomes that single account's password. Every device that enters the same
// correct password signs in to the exact same account (same uid), which is
// how the data ends up shared/synced.
// ============================================================================
import {
  initializeApp
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth, setPersistence, inMemoryPersistence,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  onAuthStateChanged, signOut, updatePassword,
  EmailAuthProvider, reauthenticateWithCredential
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, deleteDoc, onSnapshot, enableIndexedDbPersistence,
  collection, getDocs
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const cfg = window.FIREBASE_CONFIG;
const isConfigured = !!(cfg && cfg.apiKey && !String(cfg.apiKey).startsWith("PASTE_"));

if(!isConfigured){
  // firebase-config.js hasn't been filled in yet — signal "no sync available"
  // so the app falls back to plain localStorage, no password gate, exactly
  // like before this feature existed.
  window.AppSync = null;
  window.dispatchEvent(new Event("appsync-ready"));
} else {

const app = initializeApp(cfg);
const auth = getAuth(app);
const db = getFirestore(app);

// inMemoryPersistence: nothing is written to the browser's storage, so every
// time the page is opened (or reloaded), the sign-in state is gone and the
// password screen shows up again — "ask for the password every time".
setPersistence(auth, inMemoryPersistence).catch(()=>{});
try{ enableIndexedDbPersistence(db); }catch(e){ /* multiple tabs open, fine */ }

// One fixed account for the whole workshop. Not shown to the user anywhere.
const FIXED_EMAIL = "workshop@" + (cfg.projectId || "app") + ".local";
const SETUP_DOC = doc(db, "meta", "setup");
const workspaceDoc = (uid) => doc(db, "workspaces", uid);
// Photos live in their own subcollection (one small doc per photo) instead of
// inline inside the workspace doc. Firestore caps a single document at 1MB —
// with photos inline, a workshop with a lot of product/fabric pictures could
// hit that ceiling. Splitting them out means the workspace doc stays tiny
// (just text/numbers) no matter how many photos get added, and each photo
// doc is far under the 1MB limit on its own. This still runs entirely on the
// free Spark plan — no billing account needed (Firebase Storage, the other
// way to solve this, now requires the paid Blaze plan even for small usage).
const imagesCol = (uid) => collection(db, "workspaces", uid, "images");
const imageDoc = (uid, imageId) => doc(db, "workspaces", uid, "images", imageId);

let unsubscribeSnapshot = null;
let unsubscribeImagesSnapshot = null;

function friendlyError(e){
  const code = (e && e.code) || "";
  if(code.includes("wrong-password") || code.includes("invalid-credential")) return "كلمة السر غلط";
  if(code.includes("too-many-requests")) return "محاولات كتير غلط، حاول بعد شوية";
  if(code.includes("network-request-failed")) return "مفيش اتصال بالإنترنت";
  if(code.includes("weak-password")) return "كلمة السر لازم تكون 6 حروف/أرقام على الأقل";
  return "حصل خطأ، حاول تاني";
}

window.AppSync = {
  // does the workshop-wide password already exist?
  async checkHasPassword(){
    try{
      const snap = await getDoc(SETUP_DOC);
      return snap.exists();
    }catch(e){
      throw new Error(friendlyError(e));
    }
  },
  // first time ever: user picks the password
  async setup(password){
    try{
      await createUserWithEmailAndPassword(auth, FIXED_EMAIL, password);
      await setDoc(SETUP_DOC, { createdAt: Date.now() });
    }catch(e){ throw new Error(friendlyError(e)); }
  },
  // returning: user enters the password
  async login(password){
    try{
      await signInWithEmailAndPassword(auth, FIXED_EMAIL, password);
    }catch(e){ throw new Error(friendlyError(e)); }
  },
  async changePassword(oldPassword, newPassword){
    try{
      const user = auth.currentUser;
      if(!user) throw new Error("مفيش حد مسجل دخول");
      const cred = EmailAuthProvider.credential(FIXED_EMAIL, oldPassword);
      await reauthenticateWithCredential(user, cred);
      await updatePassword(user, newPassword);
    }catch(e){ throw new Error(friendlyError(e)); }
  },
  async logout(){
    if(unsubscribeSnapshot){ unsubscribeSnapshot(); unsubscribeSnapshot = null; }
    if(unsubscribeImagesSnapshot){ unsubscribeImagesSnapshot(); unsubscribeImagesSnapshot = null; }
    await signOut(auth);
  },
  // fires once at start, and again on every login/logout
  onReady(cb){ onAuthStateChanged(auth, cb); },
  async loadData(uid){
    try{
      const snap = await getDoc(workspaceDoc(uid));
      return snap.exists() ? snap.data().state : null;
    }catch(e){ return null; }
  },
  async saveData(uid, stateObj){
    await setDoc(workspaceDoc(uid), { state: stateObj, updatedAt: Date.now() });
  },
  // live updates from other devices
  subscribe(uid, onChange){
    if(unsubscribeSnapshot) unsubscribeSnapshot();
    unsubscribeSnapshot = onSnapshot(workspaceDoc(uid), (snap)=>{
      if(snap.exists()) onChange(snap.data().state);
    });
  },
  // ---- photos subcollection (see comment above imagesCol) ----
  // one-time fetch of every stored photo: { imageId: dataURL, ... }
  async loadImages(uid){
    try{
      const snap = await getDocs(imagesCol(uid));
      const map = {};
      snap.forEach(d => { map[d.id] = d.data().data; });
      return map;
    }catch(e){ return {}; }
  },
  async saveImage(uid, imageId, dataUrl){
    await setDoc(imageDoc(uid, imageId), { data: dataUrl, updatedAt: Date.now() });
  },
  async deleteImage(uid, imageId){
    try{ await deleteDoc(imageDoc(uid, imageId)); }catch(e){ /* already gone, fine */ }
  },
  // live updates from other devices: fires with { imageId: dataURL|null, ... }
  // for whatever changed since the last event (null = photo was removed)
  subscribeImages(uid, onChange){
    if(unsubscribeImagesSnapshot) unsubscribeImagesSnapshot();
    unsubscribeImagesSnapshot = onSnapshot(imagesCol(uid), (snap)=>{
      const changes = {};
      let any = false;
      snap.docChanges().forEach(ch=>{
        any = true;
        changes[ch.doc.id] = ch.type === 'removed' ? null : ch.doc.data().data;
      });
      if(any) onChange(changes);
    });
  }
};

window.dispatchEvent(new Event("appsync-ready"));

}
