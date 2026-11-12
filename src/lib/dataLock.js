// Whether the Data tab's PIN was entered. Kept in memory only, so it is asked
// again after the app restarts or is locked (App.jsx calls lockData).
let unlocked = false

export const isDataUnlocked = () => unlocked
export const setDataUnlocked = () => {
  unlocked = true
}
export const lockData = () => {
  unlocked = false
}
