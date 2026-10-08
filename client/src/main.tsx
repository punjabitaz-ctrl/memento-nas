import React from 'react';
import ReactDOM from 'react-dom/client';
// Fonts are bundled locally: no request ever goes to Google Fonts (privacy + works offline on a LAN).
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/crimson-pro/latin-400.css';
import '@fontsource/crimson-pro/latin-600.css';
import '@fontsource/crimson-pro/latin-700.css';
import './styles/base.css';
import './styles/extra.css';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
