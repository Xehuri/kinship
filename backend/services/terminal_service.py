"""
Terminal Service - Cross-platform terminal process management
Works on Windows, Linux, and macOS

For Windows: Uses UTF-8 text mode pipes for proper Chinese character support
"""
import os
import sys
import asyncio
import signal
import subprocess
import ctypes
import threading
import queue
from typing import Dict, Optional, Callable, Any, List
from datetime import datetime
import uuid


class TerminalProcess:
    """Terminal process manager - cross-platform"""
    
    def __init__(self, terminal_id: str, cols: int = 80, rows: int = 24):
        self.terminal_id = terminal_id
        self.cols = cols
        self.rows = rows
        self.process: Optional[subprocess.Popen] = None
        self.output_callback: Optional[Callable] = None
        self.exit_callback: Optional[Callable] = None
        self.is_running = False
        self._output_queue: queue.Queue = queue.Queue()
        self._read_thread: Optional[threading.Thread] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
    
    def start(self, shell: Optional[str] = None, cwd: Optional[str] = None) -> bool:
        """Start terminal process"""
        if self.is_running:
            return True
        
        # Default shell
        if shell is None:
            if sys.platform == 'win32':
                self._shell = os.environ.get('COMSPEC', 'cmd.exe')
            else:
                self._shell = os.environ.get('SHELL', '/bin/bash')
        else:
            self._shell = shell
        
        # Working directory
        cwd = cwd or os.getcwd()
        
        try:
            # Get event loop for callbacks
            try:
                self._loop = asyncio.get_event_loop()
            except:
                self._loop = asyncio.new_event_loop()
                asyncio.set_event_loop(self._loop)
            
            # Create process with pipes
            if sys.platform == 'win32':
                # Windows: Use PowerShell with UTF-8 output
                # Note: PowerShell reads stdin with system default encoding (GBK on Chinese Windows)
                # We use binary mode and encode with GBK for input, UTF-8 for output
                try:
                    import ctypes
                    ctypes.windll.kernel32.SetConsoleCP(65001)
                    ctypes.windll.kernel32.SetConsoleOutputCP(65001)
                except:
                    pass
                
                env = dict(os.environ)
                env['TERM'] = 'xterm-256color'
                env['PYTHONIOENCODING'] = 'utf-8'
                
                # Use PowerShell - we'll handle encoding manually
                self.process = subprocess.Popen(
                    ['powershell.exe', '-NoLogo'],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    cwd=cwd,
                    shell=False,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                    env=env
                    # No encoding/text - use binary mode
                )
            else:
                # Unix: Use UTF-8 text mode
                self.process = subprocess.Popen(
                    [self._shell],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    cwd=cwd,
                    shell=False,
                    env=dict(os.environ, TERM='xterm-256color', LANG='en_US.UTF-8'),
                    encoding='utf-8',
                    text=True,
                    errors='replace'
                )
            
            self.is_running = True
            
            # Start output reader thread
            self._read_thread = threading.Thread(target=self._read_output_thread, daemon=True)
            self._read_thread.start()
            
            return True
            
        except Exception as e:
            print(f"Failed to start terminal: {e}")
            return False
    
    def _read_output_thread(self):
        """Read output in background thread - GBK for PowerShell output on Chinese Windows"""
        if not self.process or not self.process.stdout:
            return
        
        try:
            while self.is_running and self.process.poll() is None:
                try:
                    if sys.platform == 'win32':
                        # Read bytes directly from stdout (already binary mode)
                        line_bytes = self.process.stdout.readline()
                        if not line_bytes:
                            break
                        # PowerShell outputs GBK on Chinese Windows
                        text = line_bytes.decode('gbk', errors='replace')
                    else:
                        text = self.process.stdout.readline()
                        if not text:
                            break
                    
                    # Put in queue for async processing
                    self._output_queue.put(text)
                    
                    # Schedule callback in event loop
                    if self.output_callback and self._loop and self._loop.is_running():
                        asyncio.run_coroutine_threadsafe(
                            self.output_callback(self.terminal_id, text),
                            self._loop
                        )
                    
                except Exception as e:
                    if self.is_running:
                        pass
                    break
                    
        except Exception as e:
            print(f"Terminal read thread error: {e}")
        finally:
            self.is_running = False
            if self.exit_callback and self._loop:
                try:
                    asyncio.run_coroutine_threadsafe(
                        self.exit_callback(self.terminal_id),
                        self._loop
                    )
                except:
                    pass
    
    def write(self, data: str) -> bool:
        """Write data to terminal"""
        if not self.is_running or not self.process or not self.process.stdin:
            return False
        
        try:
            if sys.platform == 'win32':
                # PowerShell reads stdin with system default encoding (GBK on Chinese Windows)
                # Encode to GBK for proper Chinese character support
                data_bytes = data.encode('gbk', errors='replace')
                self.process.stdin.write(data_bytes)
                self.process.stdin.flush()
            else:
                self.process.stdin.write(data)
                self.process.stdin.flush()
            return True
        except Exception as e:
            print(f"Write error: {e}")
            return False
    
    def write_command(self, command: str) -> bool:
        """Write command to terminal (with newline)"""
        return self.write(command + '\r\n' if sys.platform == 'win32' else command + '\n')
    
    def resize(self, cols: int, rows: int):
        """Resize terminal"""
        self.cols = cols
        self.rows = rows
    
    def kill(self):
        """Kill terminal process"""
        self.is_running = False
        
        if self.process:
            try:
                self.process.stdin.close()
            except:
                pass
            
            try:
                self.process.terminate()
            except:
                pass
            
            try:
                self.process.kill()
            except:
                pass
        
        if self._read_thread and self._read_thread.is_alive():
            self._read_thread.join(timeout=1)
    
    def get_exit_code(self) -> Optional[int]:
        """Get process exit code"""
        if self.process:
            return self.process.returncode
        return None


class TerminalSession:
    """Interactive terminal session with history"""
    
    def __init__(self, session_id: str):
        self.session_id = session_id
        self.terminal: Optional[TerminalProcess] = None
        self.history: List[str] = []
        self.output: str = ""
        self.created_at = datetime.now()
        self.last_activity = datetime.now()
    
    def append_output(self, text: str):
        """Append output to history"""
        self.output += text
        self.last_activity = datetime.now()
        # Limit history size
        if len(self.output) > 100000:
            self.output = self.output[-50000:]


class TerminalManager:
    """Global terminal manager"""
    
    def __init__(self):
        self._sessions: Dict[str, TerminalSession] = {}
        self._output_handlers: Dict[str, Callable] = {}
    
    def create_session(self, cols: int = 80, rows: int = 24) -> TerminalSession:
        """Create new terminal session"""
        session_id = f"term_{uuid.uuid4().hex[:8]}"
        session = TerminalSession(session_id)
        session.terminal = TerminalProcess(session_id, cols, rows)
        self._sessions[session_id] = session
        return session
    
    def get_session(self, session_id: str) -> Optional[TerminalSession]:
        """Get terminal session"""
        return self._sessions.get(session_id)
    
    async def start_session(self, session_id: str, shell: Optional[str] = None, 
                           cwd: Optional[str] = None) -> bool:
        """Start terminal session"""
        session = self._sessions.get(session_id)
        if not session or not session.terminal:
            return False
        
        # Set output callback
        async def on_output(tid: str, text: str):
            session.append_output(text)
            if session_id in self._output_handlers:
                try:
                    await self._output_handlers[session_id](tid, text)
                except:
                    pass
        
        session.terminal.output_callback = on_output
        return session.terminal.start(shell, cwd)
    
    async def destroy_session(self, session_id: str):
        """Destroy terminal session"""
        session = self._sessions.get(session_id)
        if session:
            if session.terminal:
                session.terminal.kill()
            del self._sessions[session_id]
    
    def set_output_handler(self, session_id: str, handler: Callable):
        """Set output handler for session"""
        self._output_handlers[session_id] = handler
    
    def remove_output_handler(self, session_id: str):
        """Remove output handler"""
        if session_id in self._output_handlers:
            del self._output_handlers[session_id]
    
    def list_sessions(self) -> List[str]:
        """List all active sessions"""
        return list(self._sessions.keys())


# Global instance
terminal_manager = TerminalManager()