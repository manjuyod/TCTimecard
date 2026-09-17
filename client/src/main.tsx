import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import App from './App';
import './index.css';
import { AuthProvider } from './providers/AuthProvider';
import { AppToaster } from './components/ui/toaster';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}

// Keep existing routes/providers intact while enabling supported draft-navigation blocking.
const router = createBrowserRouter([{ path: '*', element: <AuthProvider><App /><AppToaster /></AuthProvider> }]);

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode><RouterProvider router={router} /></React.StrictMode>
);
