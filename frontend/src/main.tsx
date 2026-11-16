import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import App from './App';
import './index.css';

function ThemedToaster() {
  const dark = document.documentElement.classList.contains('dark');
  return <Toaster richColors closeButton position="top-right" theme={dark ? 'dark' : 'light'} />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
      <ThemedToaster />
    </BrowserRouter>
  </React.StrictMode>,
);
