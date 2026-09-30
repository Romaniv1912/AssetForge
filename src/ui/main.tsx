import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyForwardedTheme, isHosted, redirectToHostedUi, requestPersistentStorage } from './lib/hosted';
import './styles/app.css';

function render() {
  if (isHosted()) {
    applyForwardedTheme();
    requestPersistentStorage();
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// Prefer the hosted copy (cached models, WebGPU); fall back to this bundle.
void redirectToHostedUi().then((redirected) => {
  if (!redirected) render();
});
