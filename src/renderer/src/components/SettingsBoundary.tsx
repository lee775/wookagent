import { Component, type ReactNode } from 'react';

export class SettingsBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div className="screen" role="alert"><h1>설정을 표시하지 못했습니다</h1><p>저장된 설정 값을 확인해 주세요. 다른 화면은 계속 사용할 수 있습니다.</p></div>;
    return this.props.children;
  }
}
