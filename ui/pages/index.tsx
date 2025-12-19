import { useState } from 'react';
import { Amplify } from 'aws-amplify';
import { signIn, confirmSignIn, signOut as amplifySignOut, fetchAuthSession } from 'aws-amplify/auth';
import amplifyConfig from '../lib/amplify-config';

Amplify.configure(amplifyConfig);

interface ChatMessage {
  id: string;
  type: 'user' | 'agent';
  content: string;
  timestamp: Date;
}

type AuthStage = 'signIn' | 'newPassword' | 'signedIn';

type MaybeString = string | undefined | null;

type AgentFinding = {
  agent: string;
  status?: MaybeString;
  summary?: MaybeString;
  blockers: string[];
  recommendations: string[];
  insights?: {
    overview?: MaybeString;
    summary?: MaybeString;
    metrics?: string[];
    blockers?: string[];
    recommendations?: string[];
  };
};

type WorkflowLogEntry = {
  timestamp?: MaybeString;
  event?: MaybeString;
  message?: MaybeString;
  actor?: MaybeString;
};

type ActionItem = {
  id: string;
  description: string;
  status?: MaybeString;
  type?: MaybeString;
  owner?: MaybeString;
  riskLevel?: MaybeString;
  updatedAt?: MaybeString;
  completedAt?: MaybeString;
  lastComment?: MaybeString;
  data?: Record<string, unknown>;
  notification?: {
    subject?: MaybeString;
    body?: MaybeString;
  };
  workflowLog?: WorkflowLogEntry[];
};

type ApprovalItem = {
  id: string;
  title: string;
  risk?: MaybeString;
  requires?: MaybeString;
  status?: MaybeString;
  decision?: MaybeString;
  decidedBy?: MaybeString;
  decisionAt?: MaybeString;
  requestedAt?: MaybeString;
  lastComment?: MaybeString;
  details?: Record<string, unknown>;
  notification?: {
    subject?: MaybeString;
    body?: MaybeString;
  };
  workflowLog?: WorkflowLogEntry[];
};

type AnalysisResult = {
  summary: string;
  canFulfill: boolean | null;
  confidence: string;
  riskLevel: string;
  blockers: string[];
  agentFindings: AgentFinding[];
  actions: ActionItem[];
  approvals: ApprovalItem[];
  nextSteps: string[];
  narrative?: MaybeString;
  sessionId?: MaybeString;
  queryType?: MaybeString;
  events?: any[];
};

type ToastKind = 'success' | 'error' | 'info';

type ToastMessage = {
  id: string;
  type: ToastKind;
  message: string;
};

const initialAgentMessage: ChatMessage = {
  id: 'welcome',
      type: 'agent',
  content:
    'Hello! I\'m your SupplySense AI assistant. Ask me about inventory levels, fulfillment capacity, or supply chain optimization. For example: "Can I fulfill all customer orders this week given current inventory?"',
      timestamp: new Date(),
};

export default function Home() {
  const [authStage, setAuthStage] = useState<AuthStage>('signIn');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [pendingUser, setPendingUser] = useState('');

  const [token, setToken] = useState('');
  const [signedInUser, setSignedInUser] = useState('');

  const [messages, setMessages] = useState<ChatMessage[]>([initialAgentMessage]);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [activeSessionId, setActiveSessionId] = useState('');
  const [actionBusyIds, setActionBusyIds] = useState<Set<string>>(new Set());
  const [approvalBusyIds, setApprovalBusyIds] = useState<Set<string>>(new Set());
  const [approvalDecisionPending, setApprovalDecisionPending] = useState<Record<string, 'approve' | 'reject'>>({});
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [progressMessage, setProgressMessage] = useState('');

  const pushToast = (type: ToastKind, message: string) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(toast => toast.id !== id));
    }, 5000);
  };

  const resolveSessionId = () => (activeSessionId || analysisResult?.sessionId || '').trim();

  const setActionBusyState = (id: string, busy: boolean) => {
    setActionBusyIds(prev => {
      const next = new Set(prev);
      if (busy) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const setApprovalBusyState = (id: string, busy: boolean, decision?: 'approve' | 'reject') => {
    setApprovalBusyIds(prev => {
      const next = new Set(prev);
      if (busy) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
    setApprovalDecisionPending(prev => {
      const next = { ...prev };
      if (busy && decision) {
        next[id] = decision;
      } else {
        delete next[id];
      }
      return next;
    });
  };

  const resetChat = () => {
    setMessages([initialAgentMessage]);
    setAnalysisResult(null);
    setActiveSessionId('');
    setActionBusyIds(new Set());
    setApprovalBusyIds(new Set());
    setApprovalDecisionPending({});
    setToasts([]);
    setInputMessage('');
  };

  const completeSignIn = async (email: string) => {
      const session = await fetchAuthSession();
    const idToken = session.tokens?.idToken?.toString();
    if (!idToken) {
      throw new Error('Authentication succeeded but no ID token was returned.');
    }
    setToken(idToken);
    setSignedInUser(email);
    setAuthStage('signedIn');
    resetChat();
  };

  const handleSignIn = async () => {
    try {
      setIsAuthenticating(true);
      setAuthError('');

      const output = await signIn({ username, password });

      if (output.isSignedIn) {
        await completeSignIn(username);
      } else if (
        output.nextStep?.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED'
      ) {
        setPendingUser(username);
        setAuthStage('newPassword');
      } else {
        setAuthError('Additional authentication steps are required.');
      }
    } catch (error: any) {
      setAuthError(error?.message || 'Sign in failed.');
    } finally {
      setIsAuthenticating(false);
    }
  };

  const handleConfirmNewPassword = async () => {
    try {
      setIsAuthenticating(true);
      setAuthError('');

      const output = await confirmSignIn({ challengeResponse: newPassword });

      if (output.isSignedIn) {
        await completeSignIn(pendingUser || username);
      } else {
        setAuthError('New password was not accepted.');
      }
    } catch (error: any) {
      setAuthError(error?.message || 'Failed to set new password.');
    } finally {
      setIsAuthenticating(false);
    }
  };

  const handleSignOut = async () => {
    await amplifySignOut();
    setAuthStage('signIn');
    setToken('');
    setSignedInUser('');
    setPassword('');
    setNewPassword('');
    setAuthError('');
    resetChat();
  };


  const markActionComplete = async (action: ActionItem) => {
    if (!token) {
      pushToast('error', 'Authentication token is missing. Please sign in again.');
      return;
    }
    const sessionId = resolveSessionId();
    if (!sessionId.trim()) {
      pushToast('error', 'No active session.');
      return;
    }

    setActionBusyState(action.id, true);
    try {
      // Call ECS chat service API (routed via CloudFront /api/*)
      const response = await fetch(`/api/actions/${encodeURIComponent(action.id)}/complete`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId: sessionId.trim(),
          userId: signedInUser,
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || `Failed to mark action complete (${response.status})`);
      }

      // Update local state with response from server
      const updatedAction = payload.action || {};
      setAnalysisResult(prev => {
        if (!prev) return prev;
        const updatedActions = prev.actions.map(existing =>
          existing.id === action.id 
            ? { ...existing, status: 'Completed' as const, completedAt: updatedAction.completedAt || new Date().toISOString() } 
            : existing
        );
        return { ...prev, actions: updatedActions };
      });
      
      // Show notification info if available
      const notification = updatedAction.notification || (action as any).notification;
      if (notification?.subject) {
        pushToast('success', `Action completed and notification sent.\n\nSubject: "${notification.subject}"`);
      } else {
        pushToast('success', 'Action marked complete and notification sent.');
      }
    } catch (error: any) {
      pushToast('error', error?.message || 'Failed to complete action.');
    } finally {
      setActionBusyState(action.id, false);
    }
  };

  const submitApprovalDecision = async (approval: ApprovalItem, decision: 'approve' | 'reject') => {
    if (!token) {
      pushToast('error', 'Authentication token is missing. Please sign in again.');
      return;
    }
    const sessionId = resolveSessionId();
    if (!sessionId.trim()) {
      pushToast('error', 'No active session.');
      return;
    }

    setApprovalBusyState(approval.id, true, decision);
    try {
      // Call ECS chat service API (routed via CloudFront /api/*)
      const response = await fetch(`/api/approvals/${encodeURIComponent(approval.id)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId: sessionId.trim(),
          decision,
          approver: signedInUser,
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || `Failed to ${decision} approval (${response.status})`);
      }

      // Update local state with response from server
      const updatedApproval = payload.approval || {};
      setAnalysisResult(prev => {
        if (!prev) return prev;
        const updatedApprovals = prev.approvals.map(existing =>
          existing.id === approval.id 
            ? { 
                ...existing, 
                status: decision === 'approve' ? 'Approved' as const : 'Rejected' as const,
                decidedAt: updatedApproval.decisionAt || new Date().toISOString(),
                decidedBy: updatedApproval.decidedBy || signedInUser,
              } 
            : existing
        );
        return { ...prev, approvals: updatedApprovals };
      });
      
      // Show notification info if available
      const notification = updatedApproval.notification || (approval as any).notification;
      if (notification?.subject) {
        pushToast('success', `Approval ${decision}d and notification sent.\n\nSubject: "${notification.subject}"`);
      } else {
        pushToast('success', decision === 'approve' ? 'Approval recorded and notification sent.' : 'Approval rejected.');
      }
    } catch (error: any) {
      pushToast('error', error?.message || 'Failed to update approval.');
    } finally {
      setApprovalBusyState(approval.id, false);
    }
  };

  const handleSendMessage = async () => {
    if (!inputMessage.trim() || !token) return;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      type: 'user',
      content: inputMessage.trim(),
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    const currentQuery = inputMessage.trim();
    const sessionIdentifier = `session-${signedInUser || 'user'}-${Date.now()}`;
    setInputMessage('');
    setIsLoading(true);
    setAnalysisResult(null);
    setActiveSessionId(sessionIdentifier);
    setProgressMessage('Routing to orchestrator...');

    try {
      const maxAttempts = 2;
      let attempt = 0;
      let lastError: any = null;

      const processResponse = async (response: Response, sessionId: string) => {
        if (!response.ok || !response.body) {
          throw new Error(`HTTP error ${response.status}`);
        }

        const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

        streamLoop: while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;

              try {
                const data = JSON.parse(line.slice(6));
          
              if (data.type === 'status') {
                setProgressMessage(data.message || 'AI agents analyzing…');
                continue;
              } else if (data.type === 'analysis' || data.type === 'agent_start' || data.type === 'agent_result') {
                const prefix = data.type === 'analysis' ? '🧭' : data.type === 'agent_start' ? '🔍' : '✅';
                const eventMessage: ChatMessage = {
                  id: Date.now().toString(),
                  type: 'agent',
                  content: `${prefix} ${data.message || ''}`.trim(),
                  timestamp: new Date(),
                };
                setMessages(prev => [...prev, eventMessage]);
                if (data.message) {
                  setProgressMessage(data.message);
                }
              } else if (data.type === 'complete') {
                setProgressMessage('');
              } else if (data.type === 'final_response') {
                const parsedPayload = parsePayload(data.response);
                const result = buildAnalysisResult(parsedPayload);
                setAnalysisResult(result);
                const resolvedSessionId = (result.sessionId || sessionId || sessionIdentifier).trim();
                if (resolvedSessionId) {
                  setActiveSessionId(resolvedSessionId);
                }

                setProgressMessage('');
                const message: ChatMessage = {
                id: Date.now().toString(),
                type: 'agent',
                  content: 'Multi-agent analysis complete. See the summary below.',
                timestamp: new Date(),
                };

                setMessages(prev => [...prev, message]);
              } else if (data.type === 'error') {
                throw new Error(data.error || 'Unknown error from agent.');
              }
            } catch (err) {
              console.error('Error parsing SSE payload', err);
              continue streamLoop;
            }
          }
        }
      };

      while (attempt < maxAttempts) {
        try {
          const response = await fetchWithTimeout('/api/chat', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
              Accept: 'text/event-stream',
            },
            body: JSON.stringify({
              query: currentQuery,
              sessionId: sessionIdentifier,
              userId: signedInUser,
            }),
          }, 120_000);

          await processResponse(response, sessionIdentifier);
          lastError = null;
          break;
        } catch (error: any) {
          lastError = error;
          attempt += 1;
          if (attempt < maxAttempts && shouldRetryRequest(error)) {
            await delay(500 * attempt);
            continue;
          }
          throw error;
        }
      }

      if (lastError) {
        throw lastError;
      }
    } catch (error: any) {
      const message: ChatMessage = {
        id: Date.now().toString(),
        type: 'agent',
        content: `❌ Error: ${error?.message || 'Unknown error'}`,
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, message]);
      setActiveSessionId('');
      setProgressMessage('');
    } finally {
      setIsLoading(false);
      setProgressMessage('');
    }
  };

  const renderSummarySection = (result: AnalysisResult) => {
    const title = summaryTitleForQuery(result.queryType);
    const canFulfillLabel = result.canFulfill === null ? 'Pending' : result.canFulfill ? 'Yes' : 'No';
    const fulfillmentBadgeClass = result.canFulfill === null
      ? 'bg-white/10 text-white border border-white/20'
      : result.canFulfill
        ? 'bg-green-500/20 text-green-200 border border-green-400/40'
        : 'bg-red-500/20 text-red-200 border border-red-400/40';
    const riskBadgeClass = statusBadgeClass(result.riskLevel);
    const confidenceLabel = result.confidence || 'N/A';
    const highlightedFindings = result.agentFindings.slice(0, 3);

    return (
      <section className="bg-gradient-to-r from-blue-500/15 via-purple-500/10 to-blue-500/15 border border-white/10 rounded-2xl p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-blue-200">{title}</p>
            <h2 className="text-xl font-semibold text-white mt-1 leading-snug">
              {result.summary || 'Analysis complete.'}
            </h2>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-xs px-3 py-1 rounded-full font-medium ${riskBadgeClass}`}>
              Risk: {result.riskLevel || 'Not assessed'}
            </span>
            {result.canFulfill !== null && result.canFulfill !== undefined && (
              <span className={`text-xs px-3 py-1 rounded-full font-medium ${fulfillmentBadgeClass}`}>
                Can Fulfill: {canFulfillLabel}
              </span>
            )}
          </div>
        </div>

        <div className={`grid grid-cols-1 gap-4 ${result.canFulfill !== null && result.canFulfill !== undefined ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
          {result.canFulfill !== null && result.canFulfill !== undefined && (
            <div className="bg-white/10 border border-white/20 rounded-xl p-4">
              <p className="text-xs text-blue-200 uppercase tracking-wide">Fulfillment</p>
              <p className="text-lg font-semibold text-white mt-1">{canFulfillLabel}</p>
              {result.canFulfill === false && (
                <p className="text-xs text-red-200 mt-2">Mitigation required before execution.</p>
              )}
            </div>
          )}
          <div
            className="bg-white/10 border border-white/20 rounded-xl p-4"
            title="Weighted confidence across agents (Inventory 35%, Demand 25%, Logistics 25%, Risk 15%)."
          >
            <p className="text-xs text-blue-200 uppercase tracking-wide">Confidence</p>
            <p className="text-lg font-semibold text-white mt-1">{confidenceLabel}</p>
            <p className="text-xs text-white/70 mt-2">
              Weighted across agent confidences (Inventory 35%, Demand 25%, Logistics 25%, Risk 15%).
            </p>
          </div>
          <div className="bg-white/10 border border-white/20 rounded-xl p-4">
            <p className="text-xs text-blue-200 uppercase tracking-wide">Risk Level</p>
            <p className="text-lg font-semibold text-white mt-1">{result.riskLevel || 'Not assessed'}</p>
            {result.blockers.length === 0 && (
              <p className="text-xs text-white/70 mt-2">No critical blockers identified.</p>
            )}
          </div>
        </div>

        {result.blockers.length > 0 && (
          <div>
            <p className="text-xs text-blue-200 font-medium uppercase tracking-wide mb-2">Blockers</p>
            <ul className="list-disc pl-5 space-y-1 text-sm text-white/90">
              {result.blockers.map(blocker => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          </div>
        )}

        {highlightedFindings.length > 0 && (
          <div>
            <p className="text-xs text-blue-200 font-medium uppercase tracking-wide mb-2">Agent Highlights</p>
            <ul className="space-y-1 text-sm text-white/80">
              {highlightedFindings.map(finding => (
                <li key={`highlight-${finding.agent}`}>
                  <span className="font-semibold text-white/90">{finding.agent}:</span> {' '}
                  <span>{stripMarkdownSummary(finding.summary || 'Insight captured.')}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    );
  };

  const renderLogin = () => (
    <div className="min-h-screen flex items-center justify-center p-8">
      <div className="bg-white/10 backdrop-blur-md rounded-2xl p-8 max-w-md w-full border border-white/20 shadow-2xl">
        <div className="text-center mb-6">
          <div className="inline-flex p-4 bg-gradient-to-r from-blue-500 to-purple-600 rounded-2xl mb-4">
            <svg className="w-12 h-12 text-white" fill="currentColor" viewBox="0 0 20 20">
              <path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4zM3 10a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1v-6zM14 9a1 1 0 00-1 1v6a1 1 0 001 1h2a1 1 0 001-1v-6a1 1 0 00-1-1h-2z" />
            </svg>
          </div>
          <h1 className="text-3xl font-bold text-white mb-2">SupplySense</h1>
          <p className="text-lg text-blue-200">AI Supply Chain Intelligence</p>
        </div>

        {authStage === 'signIn' && (
          <div className="space-y-4">
            <input
              type="email"
              placeholder="Email"
              value={username}
              onChange={e => setUsername(e.target.value)}
              className="w-full p-3 bg-white/10 border border-white/20 rounded-lg text-white placeholder-blue-200"
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSignIn()}
              className="w-full p-3 bg-white/10 border border-white/20 rounded-lg text-white placeholder-blue-200"
            />
            <button
              onClick={handleSignIn}
              disabled={isAuthenticating || !username || !password}
              className="w-full bg-gradient-to-r from-blue-500 to-purple-600 text-white py-3 rounded-lg hover:from-blue-600 hover:to-purple-700 disabled:opacity-50"
            >
              {isAuthenticating ? 'Signing In…' : 'Sign In'}
            </button>
          </div>
        )}

        {authStage === 'newPassword' && (
          <div className="space-y-4">
            <p className="text-sm text-blue-100">
              A new password is required for {pendingUser || username}. Please set a permanent password to continue.
            </p>
            <input
              type="password"
              placeholder="New Password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              className="w-full p-3 bg-white/10 border border-white/20 rounded-lg text-white placeholder-blue-200"
            />
            <button
              onClick={handleConfirmNewPassword}
              disabled={isAuthenticating || !newPassword}
              className="w-full bg-gradient-to-r from-blue-500 to-purple-600 text-white py-3 rounded-lg hover:from-blue-600 hover:to-purple-700 disabled:opacity-50"
            >
              {isAuthenticating ? 'Saving…' : 'Set Password'}
            </button>
          </div>
        )}

        {authError && <p className="text-red-300 text-sm mt-4 text-center">{authError}</p>}

        <div className="text-center text-blue-200 text-xs mt-6 space-y-1">
          <p>Create a user via AWS Cognito CLI.</p>
          <p>See docs/DEPLOYMENT_GUIDE.md for instructions.</p>
        </div>
      </div>
    </div>
  );

  const renderChat = () => (
    <div className="min-h-screen flex flex-col">
      <header className="bg-white/10 backdrop-blur-md border-b border-white/20 p-4">
        <div className="max-w-6xl mx-auto flex justify-between items-center">
              <div className="flex items-center">
                <div className="p-2 bg-gradient-to-r from-blue-500 to-purple-600 rounded-lg mr-3">
              <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 20 20">
                <path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4zM3 10a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1v-6zM14 9a1 1 0 00-1 1v6a1 1 0 001 1h2a1 1 0 001-1v-6a1 1 0 00-1-1h-2z" />
              </svg>
                </div>
                <div>
              <h1 className="text-xl font-bold text-white">SupplySense</h1>
                  <p className="text-sm text-blue-200">AI Supply Chain Intelligence</p>
                </div>
              </div>
                <div className="flex items-center space-x-4">
                  <div className="flex items-center space-x-2 bg-white/10 rounded-lg px-3 py-2">
              <span className="text-xs text-blue-200">{signedInUser}</span>
                  </div>
                  <button
              onClick={handleSignOut}
              className="bg-red-500/20 hover:bg-red-500/30 text-red-200 px-4 py-2 rounded-lg"
                  >
              Sign Out
                  </button>
            </div>
          </div>
        </header>

      <main className="flex-1 overflow-y-auto px-4 py-8">
        <div className="max-w-4xl mx-auto space-y-4">
          {messages.map(message => (
            <div key={message.id} className={`flex ${message.type === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-2xl px-4 py-3 rounded-xl text-sm leading-relaxed ${
                  message.type === 'user'
                    ? 'bg-gradient-to-r from-blue-500 to-purple-600 text-white'
                    : 'bg-white/10 backdrop-blur-sm text-white border border-white/20'
                }`}
              >
                {message.content}
                    </div>
                    </div>
          ))}

          {isLoading && (
            <div className="flex justify-start">
              <div className="bg-white/10 backdrop-blur-sm text-white px-4 py-3 rounded-xl border border-white/20 flex items-center space-x-3">
                <div className="animate-spin rounded-full h-5 w-5 border-2 border-blue-400 border-t-transparent"></div>
              <span className="text-sm">
                {progressMessage || 'AI agents analyzing…'}
              </span>
                  </div>
                </div>
          )}

          {analysisResult && (
            <div className="space-y-6">
              {renderSummarySection(analysisResult)}

              <section className="bg-white/5 border border-white/10 rounded-2xl p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold text-white">Agent Insights</h3>
                    </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {analysisResult.agentFindings.map(finding => {
                    const insights = finding.insights || {};
                    const overview = insights.overview || '';
                    const metrics = insights.metrics || [];
                    const blockers = insights.blockers || finding.blockers || [];
                    const recommendations = insights.recommendations || finding.recommendations || [];
                    
                    return (
                      <div key={finding.agent} className="bg-white/5 border border-white/10 rounded-xl p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-semibold text-white capitalize">{finding.agent}</span>
                          <span className={`text-xs px-2 py-1 rounded-full font-medium ${statusBadgeClass(finding.status)}`}>
                            {formatAgentStatusLabel(finding.status)}
                          </span>
                    </div>

                        {overview ? (
                          <p className="text-sm text-white/90 leading-relaxed">{stripMarkdownSummary(overview)}</p>
                        ) : finding.summary ? (
                          <p className="text-sm text-white/80 leading-relaxed">{stripMarkdownSummary(finding.summary)}</p>
                        ) : null}
                        
                        {/* Metrics Section */}
                        {metrics.length > 0 && (
                          <div>
                            <p className="text-xs text-purple-200 font-medium mb-1.5 uppercase tracking-wide">Key Metrics</p>
                            <ul className="space-y-1 text-xs text-white/90">
                              {metrics.map((metric: string, idx: number) => (
                                <li key={`${finding.agent}-metric-${idx}`} className={metric.startsWith('  •') ? 'pl-4' : ''}>
                                  {metric}
                                </li>
                              ))}
                            </ul>
                  </div>
                        )}
                        
                        {/* Blockers Section */}
                        {blockers.length > 0 && (
                          <div>
                            <p className="text-xs text-red-200 font-medium mb-1.5 uppercase tracking-wide">Blockers</p>
                            <ul className="list-disc pl-4 text-xs text-white/80 space-y-1">
                              {blockers.map((blocker: string, idx: number) => (
                                <li key={`${finding.agent}-blocker-${idx}`}>{blocker}</li>
                              ))}
                            </ul>
                    </div>
                        )}
                        
                        {/* Recommendations Section */}
                        {recommendations.length > 0 && (
                          <div>
                            <p className="text-xs text-green-200 font-medium mb-1.5 uppercase tracking-wide">Recommendations</p>
                            <ul className="list-disc pl-4 text-xs text-white/80 space-y-1">
                              {recommendations.map((rec: string, idx: number) => (
                                <li key={`${finding.agent}-rec-${idx}`}>{rec}</li>
                              ))}
                            </ul>
                </div>
                        )}
                        
                        {/* Fallback if no detailed insights */}
                        {metrics.length === 0 && blockers.length === 0 && recommendations.length === 0 && (
                          <p className="text-sm text-white/70 italic">No detailed insights available for this agent.</p>
                        )}
                </div>
                    );
                  })}
              </div>
              </section>

              {/* Only show Actions/Approvals grid if there's actual content */}
              {(analysisResult.actions.length > 0 || analysisResult.approvals.length > 0) && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Only show Actions section if there are actions */}
                  {analysisResult.actions.length > 0 && (
                    <section className="bg-white/5 border border-white/10 rounded-2xl p-6 space-y-4">
                      <h3 className="text-lg font-semibold text-white mb-2">Recommended Actions</h3>
                      <ul className="space-y-3">
                        {analysisResult.actions.map(action => {
                        const latestLog = action.workflowLog?.[action.workflowLog.length - 1];
                        return (
                          <li key={action.id} className="bg-white/5 border border-white/10 rounded-xl p-3">
                            <div className="flex items-start justify-between gap-3">
                  <div>
                                <p className="text-sm text-white/90 font-medium">{action.description}</p>
                                <p className="text-xs text-blue-200 mt-1">Status: {formatStatusLabel(action.status)}</p>
                                {action.owner && (
                                  <p className="text-xs text-blue-200">Owner: {action.owner}</p>
                                )}
                                {action.riskLevel && (
                                  <p className="text-xs text-purple-200">Risk: {action.riskLevel}</p>
                                )}
                                {action.status && (
                                  <p className="text-xs text-blue-200">
                                    Updated {action.updatedAt ? new Date(action.updatedAt).toLocaleString() : 'recently'}
                                  </p>
                                )}
                                {action.notification?.subject && (
                                  <p className="text-xs text-blue-100">Notification drafted: {action.notification.subject}</p>
                                )}
                                {latestLog?.message && (
                                  <p className="text-xs text-white/70">Last update: {latestLog.message}</p>
                                )}
                  </div>
                              {/* Show different UI based on action status */}
                              {(action.status || '').toLowerCase().replace(/\s+/g, '_') === 'already_completed' || 
                               (action.status || '').toLowerCase().includes('already') ? (
                                <div className="text-xs px-3 py-1 rounded-lg bg-green-500/20 text-green-200 border border-green-400/40">
                                  <span>✓ Already Completed</span>
                                  {(action as any).note && (
                                    <span className="block text-green-300/70 text-[10px]">
                                      {(action as any).note}
                                    </span>
                                  )}
                </div>
                              ) : (
                                <button
                                  onClick={() => markActionComplete(action)}
                                  disabled={actionBusyIds.has(action.id) || (action.status || '').toLowerCase() === 'completed'}
                                  className={`text-xs px-3 py-1 rounded-lg transition-colors ${
                                    (action.status || '').toLowerCase() === 'completed'
                                      ? 'bg-green-500/20 text-green-200 border border-green-400/40 cursor-default'
                                      : actionBusyIds.has(action.id)
                                      ? 'bg-blue-500/20 text-blue-200 border border-blue-400/40 opacity-60 cursor-wait'
                                      : 'bg-blue-500/20 text-blue-200 border border-blue-400/40 hover:bg-blue-500/30'
                                  }`}
                                >
                                  {(action.status || '').toLowerCase() === 'completed'
                                    ? 'Completed'
                                    : actionBusyIds.has(action.id)
                                    ? 'Marking…'
                                    : 'Mark Complete'}
                                </button>
                              )}
              </div>
                          </li>
                        );
                      })}
                      </ul>
                    </section>
                  )}

                  {/* Only show Approvals section if there are approvals */}
                  {analysisResult.approvals.length > 0 && (
                    <section className="bg-white/5 border border-white/10 rounded-2xl p-6 space-y-4">
                      <h3 className="text-lg font-semibold text-white mb-2">Approvals Required</h3>
                      <ul className="space-y-3">
                        {analysisResult.approvals.map(approval => {
                        const latestLog = approval.workflowLog?.[approval.workflowLog.length - 1];
                        return (
                          <li key={approval.id} className="bg-white/5 border border-white/10 rounded-xl p-3">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <p className="text-sm text-white/90 font-medium">{approval.title}</p>
                                <p className="text-xs text-blue-200">Owner: {approval.requires || 'Unassigned'}</p>
                                <p className="text-xs text-blue-200">Status: {formatStatusLabel(approval.status)}</p>
                                {approval.risk && (
                                  <p className="text-xs text-red-300">Risk: {approval.risk}</p>
                                )}
                                {approval.decision && (
                                  <p className="text-xs text-purple-200">
                                    Decision: {formatStatusLabel(approval.decision)}{' '}
                                    {approval.decidedBy ? `by ${approval.decidedBy}` : ''}
                                  </p>
                                )}
                                {approval.notification?.subject && (
                                  <p className="text-xs text-blue-100">Notification drafted: {approval.notification.subject}</p>
                                )}
                                {latestLog?.message && (
                                  <p className="text-xs text-white/70">Last update: {latestLog.message}</p>
                                )}
                              </div>
                              <div className="flex flex-col gap-2">
                                {/* Show different UI if already decided */}
                                {['approved', 'rejected'].includes((approval.status || '').toLowerCase()) ? (
                                  <div className={`text-xs px-3 py-1 rounded-lg ${
                                    (approval.status || '').toLowerCase() === 'approved'
                                      ? 'bg-green-500/20 text-green-200 border border-green-400/40'
                                      : 'bg-red-500/20 text-red-200 border border-red-400/40'
                                  }`}>
                                    <span>✓ Already {(approval.status || '').toLowerCase() === 'approved' ? 'Approved' : 'Rejected'}</span>
                                    {(approval as any).note && (
                                      <span className="block text-[10px] opacity-70">
                                        {(approval as any).note}
                                      </span>
                                    )}
                        </div>
                                ) : (
                                  <>
                                    <button
                                      onClick={() => submitApprovalDecision(approval, 'approve')}
                                      disabled={approvalBusyIds.has(approval.id)}
                                      className={`text-xs px-3 py-1 rounded-lg transition-colors ${
                                        approvalBusyIds.has(approval.id) &&
                                          approvalDecisionPending[approval.id] === 'approve'
                                        ? 'bg-purple-500/20 text-purple-200 border border-purple-400/40 opacity-60 cursor-wait'
                                        : 'bg-purple-500/20 text-purple-200 border border-purple-400/40 hover:bg-purple-500/30'
                                      }`}
                                    >
                                      {approvalBusyIds.has(approval.id) &&
                                        approvalDecisionPending[approval.id] === 'approve'
                                      ? 'Approving…'
                                      : 'Approve'}
                                    </button>
                                    <button
                                      onClick={() => submitApprovalDecision(approval, 'reject')}
                                      disabled={approvalBusyIds.has(approval.id)}
                                      className={`text-xs px-3 py-1 rounded-lg transition-colors ${
                                        approvalBusyIds.has(approval.id) &&
                                          approvalDecisionPending[approval.id] === 'reject'
                                        ? 'bg-red-500/20 text-red-200 border border-red-400/40 opacity-60 cursor-wait'
                                        : 'bg-red-500/20 text-red-200 border border-red-400/40 hover:bg-red-500/30'
                                      }`}
                                    >
                                      {approvalBusyIds.has(approval.id) &&
                                        approvalDecisionPending[approval.id] === 'reject'
                                      ? 'Rejecting…'
                                      : 'Reject'}
                                    </button>
                                  </>
                                )}
                    </div>
                  </div>
                          </li>
                          );
                        })}
                      </ul>
                    </section>
                  )}
                </div>
              )}

              {analysisResult.nextSteps.length > 0 && (
                <section className="bg-white/5 border border-white/10 rounded-2xl p-6">
                  <h3 className="text-lg font-semibold text-white mb-3">Next Steps</h3>
                  <ol className="list-decimal pl-5 space-y-2 text-sm text-white/90">
                    {analysisResult.nextSteps.map(step => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                </section>
              )}
                  </div>
                )}
              </div>
      </main>
              
      <footer className="border-t border-white/20 p-6">
        <div className="max-w-4xl mx-auto flex space-x-3">
                  <input
                    type="text"
                    value={inputMessage}
            onChange={e => setInputMessage(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSendMessage()}
                    placeholder="Ask about inventory, orders, or supply chain optimization..."
            className="flex-1 bg-white/10 backdrop-blur-sm border border-white/20 rounded-xl px-4 py-3 text-white placeholder-blue-200 focus:outline-none focus:ring-2 focus:ring-blue-400"
                  />
                  <button
                    onClick={handleSendMessage}
            disabled={isLoading || !inputMessage.trim()}
            className="bg-gradient-to-r from-blue-500 to-purple-600 text-white px-6 py-3 rounded-xl hover:from-blue-600 hover:to-purple-700 disabled:opacity-50"
                  >
            Send
                  </button>
                </div>
      </footer>
              </div>
  );

  return (
    <div className="relative">
      <div className="pointer-events-none fixed inset-x-0 top-4 flex justify-center z-50">
        <div className="space-y-2">
          {toasts.map(toast => (
            <div
              key={toast.id}
              className={`pointer-events-auto rounded-xl px-4 py-3 text-sm shadow-lg ${
                toast.type === 'success'
                  ? 'bg-green-500/20 border border-green-400/40 text-green-100 backdrop-blur'
                  : toast.type === 'error'
                  ? 'bg-red-500/20 border border-red-400/40 text-red-100 backdrop-blur'
                  : 'bg-blue-500/20 border border-blue-400/40 text-blue-100 backdrop-blur'
              }`}
            >
              {toast.message}
            </div>
          ))}
          </div>
        </div>
      {authStage === 'signedIn' ? renderChat() : renderLogin()}
      </div>
  );
}

function parsePayload(payload: unknown): any {
  if (typeof payload === 'string') {
    try {
      return JSON.parse(payload);
    } catch (error) {
      console.warn('Unable to parse payload string', error);
      return {};
    }
  }
  return payload || {};
}

function ensureArray<T = any>(value: unknown): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value as T];
}

function formatConfidence(decision: any, root: any): string {
  const score = typeof decision?.confidence === 'number'
    ? decision.confidence
    : typeof root?.overallConfidence === 'number'
      ? root.overallConfidence
      : typeof root?.confidence === 'number'
        ? root.confidence
        : null;
  if (score === null) return 'N/A';
  return `${Math.round(score * 100)}%`;
}

function fallbackId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function toActionItem(rawAction: any): ActionItem {
  return {
    id: String(rawAction?.id ?? fallbackId('action')),
    description: rawAction?.description || 'Action',
    status: rawAction?.status,
    type: rawAction?.type,
    data: rawAction?.data,
  };
}

function toApprovalItem(rawApproval: any): ApprovalItem {
  return {
    id: String(rawApproval?.id ?? fallbackId('approval')),
    title: rawApproval?.title || 'Approval Required',
    risk: rawApproval?.risk,
    requires: rawApproval?.requires,
    status: rawApproval?.status,
    details: rawApproval?.details,
  };
}

function toAgentFinding(rawFinding: any): AgentFinding {
  return {
    agent: rawFinding?.agent || 'Agent',
    status: normalizeAgentStatus(rawFinding?.status),
    summary: normalizeAgentSummary(rawFinding),
    blockers: ensureArray<string>(rawFinding?.blockers),
    recommendations: ensureArray<string>(rawFinding?.recommendations),
    insights: rawFinding?.insights ? {
      overview: rawFinding.insights.overview,
      summary: rawFinding.insights.summary,
      metrics: ensureArray<string>(rawFinding.insights.metrics),
      blockers: ensureArray<string>(rawFinding.insights.blockers),
      recommendations: ensureArray<string>(rawFinding.insights.recommendations),
    } : undefined,
  };
}

function buildAnalysisResult(payload: any): AnalysisResult {
  const root = parsePayload(payload);
  const fusion = parsePayload(root.fusion ?? root);
  const decision = parsePayload(fusion.decision ?? root.decision);

  const summary = fusion.summary || root.summary || 'Analysis complete.';
  const blockers = ensureArray<string>(decision?.blockers);
  const agentFindings = ensureArray(fusion.agentFindings ?? root.agentFindings).map(toAgentFinding);
  const actions = ensureArray(fusion.actions ?? root.actions).map(toActionItem);
  const approvals = ensureArray(fusion.approvals ?? root.approvals).map(toApprovalItem);
  const nextSteps = ensureArray<string>(fusion.nextSteps ?? root.nextSteps);

  return {
    summary,
    canFulfill: typeof decision?.canFulfill === 'boolean' ? decision.canFulfill : null,
    confidence: formatConfidence(decision, fusion),
    riskLevel: normalizeRiskLevel(decision?.riskLevel),
    blockers,
    agentFindings,
    actions,
    approvals,
    nextSteps,
    narrative: formatNarrativeForDisplay(fusion.narrative || root.narrative),
    sessionId: fusion.sessionId || root.sessionId,
  };
}

function mapActionRecord(record: any): ActionItem {
  const payload = record?.payload ?? {};
  const id = String(record?.actionId ?? record?.id ?? payload?.id ?? fallbackId('action'));
  const notificationSubject = record?.notificationSubject ?? payload?.notificationSubject;
  const notificationBody = record?.notificationBody ?? payload?.notificationBody;
  const workflowLog = Array.isArray(record?.workflowLog)
    ? record.workflowLog.map((entry: any) => ({
        timestamp: entry?.timestamp,
        event: entry?.event,
        message: entry?.message,
        actor: entry?.actor,
      }))
    : undefined;
  return {
    id,
    description: record?.description ?? payload?.description ?? 'Action item',
    status: record?.status ?? payload?.status,
    type: record?.type ?? payload?.type,
    owner: record?.owner ?? payload?.owner,
    riskLevel: record?.riskLevel ?? payload?.riskLevel,
    updatedAt: record?.updatedAt ?? payload?.updatedAt,
    completedAt: record?.completedAt ?? payload?.completedAt,
    lastComment: record?.lastComment ?? payload?.lastComment,
    data: payload?.data ?? payload,
    notification: notificationSubject || notificationBody ? { subject: notificationSubject, body: notificationBody } : undefined,
    workflowLog,
  };
}

function mapApprovalRecord(record: any): ApprovalItem {
  const payload = record?.payload ?? {};
  const id = String(record?.approvalId ?? record?.id ?? payload?.id ?? fallbackId('approval'));
  const statusValue = record?.status ?? payload?.status;
  const notificationSubject = record?.notificationSubject ?? payload?.notificationSubject;
  const notificationBody = record?.notificationBody ?? payload?.notificationBody;
  const workflowLog = Array.isArray(record?.workflowLog)
    ? record.workflowLog.map((entry: any) => ({
        timestamp: entry?.timestamp,
        event: entry?.event,
        message: entry?.message,
        actor: entry?.actor,
      }))
    : undefined;
  return {
    id,
    title: record?.title ?? payload?.title ?? 'Approval Required',
    risk: record?.risk ?? payload?.risk,
    requires: record?.requires ?? payload?.requires,
    status: statusValue,
    decision: record?.decision ?? payload?.decision ?? statusValue,
    decidedBy: record?.decidedBy ?? payload?.decidedBy,
    decisionAt: record?.decisionAt ?? payload?.decisionAt,
    requestedAt: record?.requestedAt ?? payload?.requestedAt,
    lastComment: record?.lastComment ?? payload?.lastComment,
    details: record?.details ?? payload?.details ?? payload,
    notification: notificationSubject || notificationBody ? { subject: notificationSubject, body: notificationBody } : undefined,
    workflowLog,
  };
}

function mergeActionLists(base: ActionItem[], updates: ActionItem[]): ActionItem[] {
  const map = new Map<string, ActionItem>();
  base.forEach(action => {
    map.set(action.id, action);
  });
  updates.forEach(update => {
    const existing = map.get(update.id);
    map.set(update.id, existing ? { ...existing, ...update } : update);
  });
  return Array.from(map.values());
}

function mergeApprovalLists(base: ApprovalItem[], updates: ApprovalItem[]): ApprovalItem[] {
  const map = new Map<string, ApprovalItem>();
  base.forEach(approval => {
    map.set(approval.id, approval);
  });
  updates.forEach(update => {
    const existing = map.get(update.id);
    map.set(update.id, existing ? { ...existing, ...update } : update);
  });
  return Array.from(map.values());
}

function formatStatusLabel(value?: MaybeString): string {
  if (!value) return 'Pending';
  const cleaned = value.toString().replace(/_/g, ' ').trim();
  if (!cleaned) return 'Pending';
  return titleCase(cleaned);
}

function statusBadgeClass(status?: MaybeString): string {
  if (!status) return 'bg-white/10 text-white border border-white/20';
  const normalized = status.toLowerCase();
  const map: Record<string, string> = {
    shortfall: 'bg-red-500/20 text-red-200 border border-red-400/40',
    constraint: 'bg-orange-500/20 text-orange-200 border border-orange-400/40',
    insight: 'bg-blue-500/20 text-blue-200 border border-blue-400/40',
    clear: 'bg-green-500/20 text-green-200 border border-green-400/40',
    data_gap: 'bg-yellow-500/20 text-yellow-200 border border-yellow-400/40',
    high: 'bg-red-500/20 text-red-200 border border-red-400/40',
    medium: 'bg-amber-500/20 text-amber-200 border border-amber-400/40',
    low: 'bg-green-500/20 text-green-200 border border-green-400/40',
    info: 'bg-blue-500/20 text-blue-200 border border-blue-400/40',
    neutral: 'bg-white/10 text-white border border-white/20',
  };
  return map[normalized] || 'bg-white/10 text-white border border-white/20';
}

function normalizeRiskLevel(value: any): string {
  if (value === null || value === undefined) {
    return 'Not assessed';
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized || ['unknown', 'n/a', 'na', 'none', 'not_available'].includes(normalized)) {
    return 'Not assessed';
  }
  if (['low', 'medium', 'high', 'critical'].includes(normalized)) {
    return titleCase(normalized);
  }
  return titleCase(String(value));
}

function normalizeAgentStatus(status?: MaybeString): MaybeString {
  if (!status) return undefined;
  const normalized = status.toString().trim().toLowerCase();
  if (!normalized || ['unknown', 'n/a', 'na', 'none'].includes(normalized)) {
    return 'info';
  }
  return normalized;
}

function normalizeAgentSummary(rawFinding: any): string {
  const candidates = [
    rawFinding?.summary,
    rawFinding?.message,
    rawFinding?.details,
    rawFinding?.response,
  ];

  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('{') && trimmed.includes("'brand'")) {
        continue;
      }
      return stripMarkdownSummary(trimmed);
    }
    if (typeof candidate === 'object') {
      try {
        const serialized = JSON.stringify(candidate, null, 2);
        return stripMarkdownSummary(serialized);
      } catch (error) {
        continue;
      }
    }
  }

  return 'No findings provided for this agent.';
}

function formatNarrativeForDisplay(narrative?: MaybeString): MaybeString {
  if (!narrative) return undefined;
  const escaped = escapeHtml(narrative);
  const withoutHeadings = escaped.replace(/^#{1,6}\s*/gm, '');
  const bolded = withoutHeadings.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/__(.*?)__/g, '<strong>$1</strong>');
  const bullets = bolded.replace(/^- /gm, '• ');
  const cleaned = bullets.replace(/^\s*---\s*$/gm, '');
  const normalizedNewlines = cleaned.replace(/\r\n/g, '\n').trim();
  const paragraphs = normalizedNewlines
    .split('\n\n')
    .map(block => block.replace(/\n/g, '<br/>'))
    .filter(Boolean)
    .map(block => `<p>${block}</p>`)
    .join('');
  return paragraphs || undefined;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function extractTextFromJson(value: string): string {
  if (!value) {
    return '';
  }
  // Check if the value looks like a JSON string
  const trimmed = value.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null) {
        // Try to extract highlightSummary or detailedSummary
        const highlight = parsed.highlightSummary || parsed.summary;
        const detailed = parsed.detailedSummary || parsed.analysis;
        // Return the most appropriate field
        if (highlight && typeof highlight === 'string') {
          return highlight;
        }
        if (detailed && typeof detailed === 'string') {
          return detailed;
        }
        // If no text fields found, return the original value
        return value;
      }
    } catch (e) {
      // Not valid JSON, return as-is
      return value;
    }
  }
  return value;
}

function stripMarkdownSummary(value: string): string {
  if (!value) {
    return '';
  }
  // First, try to extract text from JSON if it's a JSON string
  let cleaned = extractTextFromJson(value);
  cleaned = cleaned.replace(/\r\n/g, '\n');
  cleaned = cleaned.replace(/^#{1,6}\s*/gm, '');
  cleaned = cleaned.replace(/^\s*[-*]\s+/gm, '• ');
  cleaned = cleaned.replace(/^\s*\d+\.\s+/gm, match => match.trim() + ' ');
  cleaned = cleaned.replace(/\*\*(.*?)\*\*/g, '$1');
  cleaned = cleaned.replace(/__(.*?)__/g, '$1');
  cleaned = cleaned.replace(/`{1,3}([^`]*)`{1,3}/g, '$1');
  cleaned = cleaned.replace(/~/g, '');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return cleaned.trim();
}

function formatAgentStatusLabel(status?: MaybeString): string {
  if (!status) return 'Insight';
  if (status === 'info') return 'Insight';
  return titleCase(status.toString());
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(/\s+/)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function summaryTitleForQuery(queryType?: MaybeString): string {
  const normalized = (queryType || '').toLowerCase();
  if (normalized.includes('fulfillment')) return 'Fulfillment Summary';
  if (normalized.includes('inventory')) return 'Inventory Summary';
  if (normalized.includes('demand')) return 'Demand Summary';
  if (normalized.includes('logistics')) return 'Logistics Summary';
  if (normalized.includes('risk')) return 'Risk Summary';
  if (normalized.includes('capacity')) return 'Capacity Planning Summary';
  return 'Analysis Summary';
}

async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit, timeoutMs = 60_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, { ...(init || {}), signal: controller.signal });
    return response;
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error('Network timeout. Please try again.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function shouldRetryRequest(error: any): boolean {
  if (!error) return false;
  const message = String(error?.message || '').toLowerCase();
  if (error?.name === 'AbortError') return true;
  if (message.includes('timeout') || message.includes('network')) return true;
  if (message.includes('failed to fetch')) return true;
  return false;
}