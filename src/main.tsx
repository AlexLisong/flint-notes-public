import React from 'react';import {createRoot} from 'react-dom/client';import App from './App';import './styles.css';import 'katex/dist/katex.min.css';
createRoot(document.getElementById('root')!).render(<App/>);
if('serviceWorker' in navigator&&import.meta.env.PROD)navigator.serviceWorker.register('/sw.js').catch(()=>{});
