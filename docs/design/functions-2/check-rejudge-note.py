"""Capture the direct-message result and require its routing note to appear once."""
import asyncio
import sys

sys.dont_write_bytecode = True
from capture import capture


SCRIPT = '|||'.join([
    "Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('검수자에게 메시지 보내기'))?.click()",
    "(()=>{const e=document.querySelector('.direct-message-box');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'다시 확인해 주세요.');e.dispatchEvent(new Event('input',{bubbles:true}));})()",
    "Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('메시지 보내기'))?.click()",
    "document.querySelector('.direct-message-box')?.scrollIntoView({block:'center'})",
])


if __name__ == '__main__':
    asyncio.run(capture('rejudge-message.png', 'capture=task-T-0008', SCRIPT, '다시 판정 실패로 보류 중이라'))
