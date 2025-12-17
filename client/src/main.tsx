import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fullcalendar/react/dist/vdom';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import { AuthProvider } from './providers/AuthProvider';
import { AppToaster } from './components/ui/toaster';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
        <AppToaster />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
