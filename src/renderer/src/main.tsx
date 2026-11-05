import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/pretendard-used.css';
import './styles/app.css';
import './styles/identity.css';

import { App } from './App';

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
