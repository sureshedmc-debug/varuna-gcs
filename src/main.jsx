import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { getTheme, applyTheme } from './lib/theme'
// Bundled rather than fetched from Google Fonts, so the app renders correctly
// with no internet (it only needs the Netbird mesh to reach the Pi). Same
// weights the old Google Fonts link requested.
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/600.css'
import './index.css'

applyTheme(getTheme())

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
