import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/pretendard-used.css';
import './styles/app.css';
import './styles/identity.css';
import { prepareBridge } from './api/install';

// 브리지를 먼저 정하고 화면 코드를 불러온다 (리드 결정 S8-4) — App과 그 아래 모듈이 `window.wook`·주소 표시를 읽을 때 이미 정해져 있게
const root = document.getElementById('root')!;
prepareBridge()
  .then(() => import('./App'))
  .then(({ App }) => {
    createRoot(root).render(<React.StrictMode><App /></React.StrictMode>);
  })
  .catch((error: unknown) => {
    console.error('[욱채] 화면을 시작하지 못했습니다', error);
    root.textContent = '화면을 시작하지 못했습니다. 페이지를 새로 고쳐 주세요.';
  });
