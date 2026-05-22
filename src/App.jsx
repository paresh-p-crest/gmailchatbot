import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import { GoogleOAuthProvider, useGoogleLogin } from '@react-oauth/google';
import { Mail, Loader2, MessageSquare, Sparkles, LogOut, RefreshCw, List, User, CheckCircle2, AlertCircle, X } from 'lucide-react';

const GOOGLE_CLIENT_ID = "1068821362236-ohuapjsgtdroun8s8oonidk7se7kb8e5.apps.googleusercontent.com";
const AWS_API_URL = "https://t5m3be9xfi.execute-api.us-east-1.amazonaws.com/dev/ingest";

function formatEmailDate(em) {
  const iso = em.received_at_iso;
  if (iso) {
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) {
      const day = String(d.getDate()).padStart(2, "0");
      const month = String(d.getMonth() + 1).padStart(2, "0");
      const year = d.getFullYear();
      let hours = d.getHours();
      const ampm = hours >= 12 ? "pm" : "am";
      hours = hours % 12 || 12;
      const mins = String(d.getMinutes()).padStart(2, "0");
      return `${day}-${month}-${year} ${String(hours).padStart(2, "0")}:${mins} ${ampm}`;
    }
  }
  if (em.received_at_display) return em.received_at_display;
  if (!em.date) return "";
  const d = new Date(em.date);
  if (Number.isNaN(d.getTime())) return em.date.split(" ").slice(1, 4).join(" ");
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  let hours = d.getHours();
  const ampm = hours >= 12 ? "pm" : "am";
  hours = hours % 12 || 12;
  const mins = String(d.getMinutes()).padStart(2, "0");
  return `${day}-${month}-${year} ${String(hours).padStart(2, "0")}:${mins} ${ampm}`;
}

function Toast({ toast, onDismiss }) {
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(onDismiss, 4500);
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);

  if (!toast) return null;

  const isSuccess = toast.type === 'success';
  return (
    <div
      role="status"
      className={`fixed bottom-6 right-6 z-[100] flex items-start gap-3 max-w-sm px-4 py-3 rounded-2xl border shadow-2xl backdrop-blur-md ${
        isSuccess
          ? 'bg-emerald-950/95 border-emerald-500/40 text-emerald-50'
          : 'bg-red-950/95 border-red-500/40 text-red-50'
      }`}
    >
      {isSuccess ? (
        <CheckCircle2 className="text-emerald-400 shrink-0 mt-0.5" size={20} />
      ) : (
        <AlertCircle className="text-red-400 shrink-0 mt-0.5" size={20} />
      )}
      <p className="text-sm font-medium leading-snug flex-1">{toast.message}</p>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 p-1 rounded-lg opacity-70 hover:opacity-100 hover:bg-white/10 transition-opacity"
        aria-label="Dismiss"
      >
        <X size={16} />
      </button>
    </div>
  );
}

function ConfirmDialog({ open, title, message, confirmLabel, onConfirm, onCancel }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm"
        onClick={onCancel}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-md bg-slate-900 border border-slate-700 rounded-2xl p-6 shadow-2xl"
      >
        <h3 className="text-lg font-bold text-slate-100 mb-2">{title}</h3>
        <p className="text-sm text-slate-400 mb-6">{message}</p>
        <div className="flex gap-3 justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-xl transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-500 rounded-xl transition-colors"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

const AppContent = () => {
  // --- SESSION STATE ---
  const [user, setUser] = useState(() => JSON.parse(localStorage.getItem('gmind_session')) || null);
  const [emails, setEmails] = useState(() => JSON.parse(localStorage.getItem('gmind_emails')) || []);
  const [status, setStatus] = useState('idle');
  const [emailLimit, setEmailLimit] = useState(50);
  const [chatInput, setChatInput] = useState("");
  const [chatHistory, setChatHistory] = useState([]);
  const [isChatting, setIsChatting] = useState(false);
  const [isResyncing, setIsResyncing] = useState(false);
  const [toast, setToast] = useState(null);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const chatScrollRef = useRef(null);

  const dismissToast = () => setToast(null);

  const scrollChatToBottom = useCallback(() => {
    const el = chatScrollRef.current;
    if (el) {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    }
  }, []);

  useEffect(() => {
    scrollChatToBottom();
  }, [chatHistory, isChatting, chatInput, scrollChatToBottom]);

  // --- GOOGLE LOGIN ---
  const login = useGoogleLogin({
    onSuccess: async (codeResponse) => {
      setStatus('syncing');
      try {
        const res = await axios.post(AWS_API_URL, { code: codeResponse.code, limit: emailLimit });
        if (res.data.status === "SUCCESS") {
          const sessionData = res.data.user;
          const emailData = res.data.emails;
          
          setUser(sessionData);
          setEmails(emailData);
          
          // Persist to browser memory
          localStorage.setItem('gmind_session', JSON.stringify(sessionData));
          localStorage.setItem('gmind_emails', JSON.stringify(emailData));
          
          setStatus('idle');
        }
      } catch (err) { setStatus('error'); }
    },
    flow: 'auth-code',
    // Ask for consent so Google returns a refresh_token (required for silent resync on the server)
    prompt: 'consent',
    scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email'
  });

  const logout = () => {
    localStorage.removeItem('gmind_session');
    localStorage.removeItem('gmind_emails');
    setUser(null);
    setEmails([]);
    setChatHistory([]);
    setIsChatting(false);
  };

  // --- SILENT RESYNC (No Popup) ---
  const handleResync = async () => {
    if (isResyncing) return;
    setIsResyncing(true);
    try {
      const res = await axios.post(AWS_API_URL, { limit: Number(emailLimit) });
      if (res.data.status === "SUCCESS") {
        setEmails(res.data.emails);
        localStorage.setItem('gmind_emails', JSON.stringify(res.data.emails));
        if (res.data.user) {
          setUser((prev) => {
            const next = { ...prev, ...res.data.user };
            localStorage.setItem('gmind_session', JSON.stringify(next));
            return next;
          });
        }
        const count = res.data.emails?.length ?? 0;
        setToast({
          type: 'success',
          message: `Sync complete — ${count} email${count === 1 ? '' : 's'} loaded from Gmail.`,
        });
      }
    } catch (err) {
      setToast({
        type: 'error',
        message: 'Session expired. Please sign in with Google again.',
      });
      logout();
    } finally {
      setIsResyncing(false);
    }
  };

  const confirmLogout = () => {
    localStorage.removeItem('gmind_session');
    localStorage.removeItem('gmind_emails');
    setUser(null);
    setEmails([]);
    setShowLogoutConfirm(false);
    setToast({ type: 'success', message: 'You have been signed out.' });
  };

  // --- LOGIN VIEW ---
  if (!user) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-3xl p-8 text-center shadow-2xl">
          <Sparkles className="text-blue-500 mx-auto mb-4" size={48} />
          <h1 className="text-3xl font-bold mb-2">Gmail Talk AI</h1>
          <p className="text-slate-400 text-sm mb-2">Amazon Bedrock Knowledge Base · Gmail RAG chat</p>
          <p className="text-[11px] text-slate-600 mb-8">
            Made by <span className="text-slate-500 font-medium">PRS</span>
          </p>
          
          <div className="mb-6 text-left">
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2 block">Initial Sync Depth</label>
            <select value={emailLimit} onChange={(e)=>setEmailLimit(e.target.value)} className="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-sm">
              <option value={10}>10 Emails</option>
              <option value={50}>50 Emails</option>
              <option value={100}>100 Emails</option>
            </select>
          </div>

          <button onClick={() => login()} className="w-full bg-white text-black font-bold py-4 rounded-xl flex items-center justify-center gap-3 hover:bg-slate-200 transition-all">
            {status === 'syncing' ? <Loader2 className="animate-spin" /> : <><Mail size={20} /> Sign in with Google</>}
          </button>
        </div>
      </div>
    );
  }

  // --- AI CHAT LOGIC ---
  const handleChat = async () => {
    if (isResyncing || !chatInput.trim()) return;

    // 1. Add user message to UI immediately
    const userMsg = { role: 'user', text: chatInput };
    setChatHistory(prev => [...prev, userMsg]);
    setChatInput("");
    setIsChatting(true);
    scrollChatToBottom();

    try {
      const CHAT_URL = AWS_API_URL.replace('/ingest', '/chat');
      const res = await axios.post(CHAT_URL, {
        question: userMsg.text,
        emails: emails.map((e, i) => ({
          from: e.from,
          subject: e.subject,
          date: e.date,
          received_at_display: e.received_at_display,
          received_at_iso: e.received_at_iso,
          sync_order: e.sync_order ?? i + 1,
        })),
      });
      
      // 3. Add AI response to UI
      const aiMsg = { role: 'ai', text: res.data.answer };
      setChatHistory(prev => [...prev, aiMsg]);
    } catch (err) {
      console.error("Chat Error:", err);
      setChatHistory(prev => [...prev, { role: 'ai', text: "Error: I couldn't reach the Knowledge Base. Please check your API." }]);
    }
    setIsChatting(false);
  };

  // --- DASHBOARD VIEW ---
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Navbar */}
      <nav className="border-b border-slate-800 bg-slate-900/50 px-8 py-4 flex items-center justify-between sticky top-0 z-10 backdrop-blur-md">
        <div className="flex items-center gap-2">
          <Sparkles className="text-blue-500" size={24} />
          <span className="font-bold text-xl tracking-tight">Gmail Talk AI</span>
        </div>
        
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3 bg-slate-800 px-4 py-1.5 rounded-full border border-slate-700">
            {user.picture ? (
              <img
                src={user.picture}
                alt=""
                referrerPolicy="no-referrer"
                className="w-6 h-6 rounded-full border border-blue-500 bg-slate-700 object-cover"
              />
            ) : (
              <div className="w-6 h-6 rounded-full border border-blue-500 bg-slate-700 flex items-center justify-center text-slate-400">
                <User size={14} aria-hidden />
              </div>
            )}
            <span className="text-sm font-medium">{user.name}</span>
          </div>
          <div className="flex flex-col items-center gap-0.5">
            <button
              type="button"
              onClick={() => setShowLogoutConfirm(true)}
              className="text-slate-400 hover:text-red-400 transition-colors p-1"
              title="Sign out"
            >
              <LogOut size={20} />
            </button>
            <p className="text-[10px] text-slate-600 whitespace-nowrap leading-tight">
              Made by <span className="text-slate-500 font-medium">PRS</span>
            </p>
          </div>
        </div>
      </nav>

      <main className="flex-grow grid grid-cols-1 lg:grid-cols-12 gap-6 p-8 max-w-[1600px] mx-auto w-full">
        
        {/* Left: Email Feed */}
        <div className="lg:col-span-4 space-y-4 flex flex-col h-[80vh]">
          <div className="flex items-center justify-between mb-2">
            <h2 className="flex items-center gap-2 font-bold text-slate-400 uppercase text-xs tracking-widest"><List size={16}/> Sync Feed</h2>
            <button
              type="button"
              onClick={handleResync}
              disabled={isResyncing}
              className="text-[10px] bg-blue-600/20 text-blue-400 px-3 py-1 rounded-md hover:bg-blue-600/40 transition-all flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isResyncing ? (
                <Loader2 size={10} className="animate-spin" />
              ) : (
                <RefreshCw size={10} />
              )}
              {isResyncing ? 'Syncing…' : 'Resync'}
            </button>
          </div>
          
          <div
            className={`relative bg-slate-900 rounded-2xl border border-slate-800 flex-grow shadow-inner ${
              isResyncing ? "overflow-hidden" : "overflow-y-auto custom-scrollbar"
            }`}
          >
            {isResyncing && (
              <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-slate-950/90 backdrop-blur-md rounded-2xl">
                <Loader2 className="animate-spin text-blue-500" size={28} />
                <p className="text-xs font-medium text-slate-300">Fetching emails from Gmail…</p>
              </div>
            )}
            {emails.map((em, i) => (
              <div key={i} className="p-4 border-b border-slate-800 hover:bg-slate-800/40 transition-colors group cursor-default">
                <div className="flex justify-between items-start mb-1">
                  <span className="text-[10px] font-bold text-blue-500 truncate max-w-[150px]">{em.from}</span>
                  <span className="text-[9px] text-slate-500 shrink-0 ml-2">{formatEmailDate(em)}</span>
                </div>
                <h3 className="text-xs font-semibold text-slate-200 mb-1 line-clamp-1 group-hover:text-white">{em.subject}</h3>
                <p className="text-[10px] text-slate-500 line-clamp-2 leading-relaxed">{em.body_snippet}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Right: AI Chat */}
        <div className="lg:col-span-8 relative bg-slate-900 rounded-3xl border border-slate-800 shadow-2xl flex flex-col h-[80vh] overflow-hidden">
          {isResyncing && (
            <div
              className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-slate-950/90 backdrop-blur-md rounded-3xl"
              aria-busy="true"
              aria-live="polite"
            >
              <Loader2 className="animate-spin text-blue-500" size={32} />
              <p className="text-sm font-medium text-slate-300">Syncing inbox…</p>
              <p className="text-xs text-slate-500">Chat is paused until sync completes</p>
            </div>
          )}
          <div className="p-6 border-b border-slate-800 flex items-center justify-between bg-slate-900/80 shrink-0">
            <div>
              <h2 className="font-bold text-lg flex items-center gap-2"><MessageSquare className="text-purple-500" size={20}/> Email Intelligence</h2>
              <p className="text-[10px] text-slate-500">Amazon Bedrock Knowledge Base · Gmail RAG chat</p>
            </div>
          </div>

          <div
            ref={chatScrollRef}
            className={`flex-grow p-6 space-y-6 bg-slate-950/30 min-h-0 ${
              isResyncing ? "overflow-hidden" : "overflow-y-auto"
            }`}
            aria-hidden={isResyncing}
          >
            {chatHistory.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center px-20">
                <div className="bg-slate-800 p-4 rounded-3xl mb-4 text-slate-400"><MessageSquare size={32}/></div>
                <h3 className="font-bold text-slate-300">Ready to analyze</h3>
                <p className="text-sm text-slate-500 mt-1">Ask questions like "Who sent me emails about the project?"</p>
              </div>
            ) : (
              chatHistory.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                 <div className={`max-w-[80%] p-4 rounded-2xl text-sm leading-relaxed ${
                    msg.role === 'user' 
                    ? 'bg-blue-600 text-white rounded-tr-none' 
                    : 'bg-slate-800 text-slate-200 border border-slate-700 rounded-tl-none whitespace-pre-line'
                  }`}>
                    {msg.text}
                  </div>
                </div>
              ))
            )}
            {isChatting && (
              <div className="flex justify-start">
                <div className="bg-slate-800 p-4 rounded-2xl rounded-tl-none border border-slate-700">
                  <Loader2 className="animate-spin text-blue-500" size={16} />
                </div>
              </div>
            )}
          </div>

          <div className="p-6 bg-slate-900 border-t border-slate-800">
            <div className="flex gap-3 bg-slate-800 p-2 rounded-2xl border border-slate-700 focus-within:border-blue-500 transition-all">
            <input 
              className="bg-transparent border-0 flex-grow px-4 text-sm outline-none placeholder:text-slate-500 disabled:opacity-50 disabled:cursor-not-allowed" 
              placeholder={isResyncing ? "Syncing inbox…" : "Ask Gmail Talk AI..."}
              value={chatInput}
              disabled={isResyncing || isChatting}
              onChange={(e)=>setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !isResyncing) handleChat();
              }}
            />
            <button 
              type="button"
              onClick={handleChat}
              disabled={isResyncing || isChatting}
              className="bg-blue-600 p-3 rounded-xl hover:bg-blue-500 shadow-lg active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Sparkles size={18} />
            </button>
            </div>
          </div>
        </div>

      </main>

      <Toast toast={toast} onDismiss={dismissToast} />
      <ConfirmDialog
        open={showLogoutConfirm}
        title="Sign out?"
        message="This will clear your session and synced emails from this browser."
        confirmLabel="Sign out"
        onConfirm={confirmLogout}
        onCancel={() => setShowLogoutConfirm(false)}
      />
    </div>
  );
};

function App() {
  return (
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
      <AppContent />
    </GoogleOAuthProvider>
  );
}

export default App;
