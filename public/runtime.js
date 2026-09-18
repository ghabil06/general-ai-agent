/*
 * Operator console for the runtime API.
 *
 * Plain DOM, no dependency, no framework, no build step. Every view is built
 * from the response of a `/api/runtime/*` call and nothing else — there is no
 * hardcoded run, agent or approval anywhere in this file, and no view renders
 * invented content.
 *
 * Keyboard first: navigation is a list of real links, every action is a real
 * form with a submit button, long JSON lives behind native <details>, and the
 * status line is an aria-live region so a state change is announced.
 */
(function () {
  'use strict';

  var API = '/api/runtime';
  var viewRoot = document.getElementById('view');
  var statusLine = document.getElementById('status');
  var refreshButton = document.getElementById('refresh');
  var navLinks = Array.prototype.slice.call(document.querySelectorAll('nav.views a'));

  /** Client-side view state. Never a source of truth — the API is. */
  var state = { runAgentFilter: '', approvalFilter: 'pending' };

  /* ── DOM helpers ───────────────────────────────────────────────────────── */

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === null || value === undefined || value === false) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'onclick') node.addEventListener('click', value);
        else node.setAttribute(key, String(value));
      });
    }
    appendAll(node, children);
    return node;
  }

  function appendAll(node, children) {
    if (children === null || children === undefined) return;
    var list = Array.isArray(children) ? children : [children];
    list.forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      if (Array.isArray(child)) return appendAll(node, child);
      node.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
    });
  }

  function fragment(children) {
    var frag = document.createDocumentFragment();
    appendAll(frag, children);
    return frag;
  }

  /** A dash for a value that is genuinely absent. */
  function show(value) {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    return String(value);
  }

  function iso(ms) {
    if (typeof ms !== 'number') return '—';
    try {
      return new Date(ms).toISOString();
    } catch (error) {
      return String(ms);
    }
  }

  function kv(pairs) {
    var nodes = [];
    pairs.forEach(function (pair) {
      if (!pair) return;
      nodes.push(el('dt', { text: pair[0] }));
      nodes.push(el('dd', null, pair[1]));
    });
    return el('dl', { class: 'kv' }, nodes);
  }

  function table(caption, headers, rows, options) {
    var opts = options || {};
    var headRow = el('tr', null, headers.map(function (header, index) {
      return el('th', { scope: 'col', class: opts.numeric && opts.numeric.indexOf(index) >= 0 ? 'num' : null }, header);
    }));
    var body = el('tbody', null, rows.map(function (row) {
      return el('tr', null, row.map(function (cell, index) {
        return el('td', { class: opts.numeric && opts.numeric.indexOf(index) >= 0 ? 'num' : null }, cell);
      }));
    }));
    return el('div', { class: 'table-wrap' }, [
      el('table', null, [el('caption', { text: caption }), el('thead', null, headRow), body]),
    ]);
  }

  function json(value, summary, open) {
    return el('details', open ? { open: 'open' } : null, [
      el('summary', { text: summary }),
      el('pre', { text: JSON.stringify(value, null, 2) }),
    ]);
  }

  function stateBlock(kind, message) {
    return el('p', { class: 'state ' + kind, role: kind === 'error' ? 'alert' : null }, message);
  }

  function errorBlock(error) {
    return el('div', { class: 'state error', role: 'alert' }, [
      el('strong', { text: (error && error.code ? error.code : 'REQUEST_FAILED') + ': ' }),
      show(error && error.message ? error.message : String(error)),
      error && error.requestId ? el('p', { class: 'hint', text: 'request ' + error.requestId }) : null,
      error && error.details ? json(error.details, 'Error details') : null,
    ]);
  }

  /* ── API access ────────────────────────────────────────────────────────── */

  function api(path, options) {
    var method = (options && options.method) || 'GET';
    return fetch(API + path, options).then(function (response) {
      return response.text().then(function (body) {
        var parsed = null;
        try {
          parsed = JSON.parse(body);
        } catch (error) {
          parsed = null;
        }
        if (!response.ok || (parsed && parsed.error)) {
          var failure = new Error(
            parsed && parsed.error ? parsed.error.message : 'HTTP ' + response.status + ' ' + String(body).slice(0, 200),
          );
          failure.code = parsed && parsed.error ? parsed.error.code : 'HTTP_' + response.status;
          failure.status = response.status;
          failure.requestId = parsed ? parsed.requestId : null;
          failure.details = parsed && parsed.error ? parsed.error.details : null;
          throw failure;
        }
        if (statusLine) {
          statusLine.textContent = method + ' ' + path + ' → ' + response.status + ' (request ' + (parsed.requestId || 'n/a') + ')';
        }
        return parsed;
      });
    });
  }

  function post(path, body) {
    return api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  }

  /* ── Agents ────────────────────────────────────────────────────────────── */

  function agentDetails(agent) {
    return el('details', null, [
      el('summary', { text: agent.id + ' — ' + agent.name }),
      kv([
        ['boundary', agent.boundarySummary],
        ['domain boundary', agent.hasDomainBoundary ? 'yes' : 'no — the generic kernel only'],
        ['escalation tool', show(agent.escalationTool)],
        ['escalation disposition', show(agent.escalationDisposition)],
        ['autonomous disposition', show(agent.autonomousDisposition)],
        ['permissions', agent.permissions.join(', ') || '—'],
        ['data access', agent.dataAccess.join(', ') || '—'],
        ['prompt of record', show(agent.prompt.path || agent.prompt.source)],
        ['guardrail prompt', show(agent.prompt.guardrailPath)],
        ['dataset', agent.dataset && agent.dataset.path ? agent.dataset.path + ' (' + agent.dataset.cases + ' cases)' : '—'],
        ['offline fixture', agent.offlineFixture],
        ['definition error', show(agent.definitionError)],
      ]),
      el('h4', { text: 'Limits (the run may only tighten these)' }),
      json(agent.limits, 'limits', false),
      el('h4', { text: 'Tools this profile holds' }),
      table(
        agent.id + ' tools',
        ['tool', 'risk', 'side effect', 'needs confirmation', 'permissions'],
        agent.toolDetails.map(function (tool) {
          return [
            tool.registered ? tool.name : tool.name + ' (NOT REGISTERED)',
            show(tool.riskLevel),
            show(tool.sideEffect),
            show(tool.requiresConfirmation),
            (tool.permissions || []).join(', ') || '—',
          ];
        }),
      ),
      el('h4', { text: 'Action policy (numeric ceilings from the frozen boundary)' }),
      json(agent.actionPolicy, 'action policy'),
      el('h4', { text: 'Evaluation suites declared for this agent' }),
      el('ul', { class: 'plain' }, agent.suites.map(function (suite) {
        return el('li', { text: suite });
      })),
    ]);
  }

  function runResultBlock(result) {
    var nodes = [
      el('h3', { text: 'Run started' }),
      kv([
        ['run id', el('a', { href: '#/runs/' + result.runId, text: result.runId })],
        ['status', result.status],
        ['state', result.state],
        ['terminal', result.terminal ? 'yes' : 'no — waiting for a human'],
        ['agent', result.agentId],
        ['provider', result.provider + (result.providerIsMock ? ' (deterministic test double)' : '')],
        ['proposal source', show(result.scriptedBy)],
        ['disposition', result.decision ? result.decision.action : 'none reached (the run stopped at a gate)'],
        ['kernel verdict', result.policyDecision ? result.policyDecision.decision + ' — ' + result.policyDecision.reason : '—'],
        ['tool calls', result.toolCalls.join(', ') || '—'],
        ['pending approval', result.pendingApprovalId ? el('a', { href: '#/approvals', text: result.pendingApprovalId }) : '—'],
        ['resumed with approval', show(result.resumedWithApprovalId)],
        ['matched dataset case', show(result.matchedDatasetCase)],
        ['stop reason', result.stopReason ? result.stopReason.code + ': ' + result.stopReason.message : '—'],
      ]),
      json(result.decision, 'decision JSON', false),
      json(result.evidence, 'structured evidence the kernel was given', false),
    ];
    if (result.notes && result.notes.length) {
      nodes.push(el('h4', { text: 'How this run was built' }));
      nodes.push(el('ul', { class: 'notes' }, result.notes.map(function (note) {
        return el('li', { text: note });
      })));
    }
    if (result.offlineNote) nodes.push(el('p', { class: 'note', text: result.offlineNote }));
    return el('section', { class: 'block' }, nodes);
  }

  function startRunForm(agents) {
    var agentSelect = el('select', { id: 'run-agent', name: 'agent' }, agents.map(function (agent) {
      return el('option', { value: agent.id, text: agent.id + ' — ' + agent.name });
    }));
    var providerSelect = el('select', { id: 'run-provider', name: 'provider' }, [
      el('option', { value: '', text: 'the server default' }),
      el('option', { value: 'mock', text: 'mock — offline deterministic double' }),
      el('option', { value: 'openai', text: 'openai — needs OPENAI_API_KEY' }),
      el('option', { value: 'anthropic', text: 'anthropic — needs ANTHROPIC_API_KEY' }),
      el('option', { value: 'local', text: 'local — needs LOCAL_MODEL_BASE_URL' }),
    ]);
    var planningSelect = el('select', { id: 'run-planning', name: 'planning' }, [
      el('option', { value: 'model', text: 'model — follow the model\'s own tool calls' }),
      el('option', { value: 'planned', text: 'planned — decompose the goal, then run the plan' }),
    ]);
    var input = el('textarea', { id: 'run-input', name: 'input', rows: 8, spellcheck: 'false' });
    var approvalInput = el('input', { id: 'run-approval', name: 'approvalId', type: 'text', autocomplete: 'off' });
    var resultHost = el('div', { id: 'run-result' });
    var submit = el('button', { type: 'submit', text: 'Start the run' });

    var form = el('form', { class: 'start', id: 'run-form', novalidate: 'novalidate' }, [
      el('label', { for: 'run-agent', text: 'Agent profile' }),
      agentSelect,
      el('label', { for: 'run-input', text: 'Payload or task (the untrusted text the agent runs against)' }),
      input,
      el('p', { class: 'hint' }, [
        'Paste a dataset payload verbatim and the offline double replays the reference (oracle) fixture for it; ' +
        'any other text replays the naive keyword fixture, which is what lets the policy kernel refuse it. ' +
        'A disposition that hands the decision to a human is proposed as the escalation tool call, so the run pauses ' +
        'on a real approval.',
      ]),
      el('label', { for: 'run-provider', text: 'Provider' }),
      providerSelect,
      el('label', { for: 'run-planning', text: 'Planning' }),
      planningSelect,
      el('label', { for: 'run-approval', text: 'Resume with approval id (optional)' }),
      approvalInput,
      el('p', { class: 'hint', text: 'Fill this to re-propose a gated call that a human has already approved.' }),
      el('div', { class: 'form-actions' }, submit),
    ]);

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      resultHost.replaceChildren(stateBlock('loading', 'Running… the run is executed by the server, not the browser.'));
      submit.disabled = true;
      var payload = { input: input.value };
      if (agentSelect.value) payload.agentId = agentSelect.value;
      if (providerSelect.value) payload.provider = providerSelect.value;
      if (planningSelect.value) payload.planning = planningSelect.value;
      if (approvalInput.value.trim()) payload.approvalId = approvalInput.value.trim();

      post('/agents/' + encodeURIComponent(agentSelect.value) + '/runs', payload)
        .then(function (result) {
          resultHost.replaceChildren(runResultBlock(result));
        })
        .catch(function (error) {
          resultHost.replaceChildren(errorBlock(error));
        })
        .finally(function () {
          submit.disabled = false;
        });
    });

    return el('section', { class: 'block' }, [
      el('h2', { text: 'Start a run' }),
      el('p', { class: 'prose', text:
        'The server runs this through the real state machine, tool executor, policy kernel, approval gate and ' +
        'stores. With the mock provider the proposal comes from a repository fixture; with a configured live ' +
        'provider it is a real model call that costs money.' }),
      form,
      resultHost,
    ]);
  }

  function renderAgents() {
    return api('/agents').then(function (body) {
      return fragment([
        el('section', { class: 'block' }, [
          el('h2', { text: 'Agent profiles (' + body.count + ')' }),
          el('p', { class: 'note', text: body.note }),
          table(
            'Agent profiles',
            ['id', 'name', 'task type', 'tools', 'tools needing confirmation', 'max tool calls'],
            body.agents.map(function (agent) {
              return [
                el('a', { href: '#/agents', text: agent.id }),
                agent.name,
                agent.taskType,
                agent.tools.join(', '),
                agent.toolDetails.filter(function (tool) { return tool.requiresConfirmation; }).map(function (tool) { return tool.name; }).join(', ') || '—',
                show(agent.limits.maxToolCalls),
              ];
            }),
          ),
        ]),
        el('section', { class: 'block' }, [
          el('h2', { text: 'Boundaries, tools and limits, per profile' }),
          body.agents.map(agentDetails),
        ]),
        startRunForm(body.agents),
      ]);
    });
  }

  /* ── Tools ─────────────────────────────────────────────────────────────── */

  function renderTools() {
    return api('/tools').then(function (body) {
      return fragment([
        el('section', { class: 'block' }, [
          el('h2', { text: 'Tool registry (' + body.count + ')' }),
          el('p', { class: 'note', text: body.note }),
          table(
            'Registered tools',
            ['tool', 'risk', 'side effect', 'needs confirmation', 'escalation', 'held by'],
            body.tools.map(function (tool) {
              return [
                tool.name,
                tool.riskLevel,
                tool.sideEffect,
                show(tool.requiresConfirmation),
                show(tool.escalation),
                tool.heldBy.join(', ') || 'no profile may call this',
              ];
            }),
          ),
        ]),
        el('section', { class: 'block' }, [
          el('h2', { text: 'Declarations' }),
          body.tools.map(function (tool) {
            return el('details', null, [
              el('summary', { text: tool.name + ' — ' + tool.riskLevel + ', ' + tool.sideEffect }),
              el('p', { class: 'prose', text: tool.description }),
              kv([
                ['destructive', show(tool.destructive)],
                ['permissions', tool.permissions.join(', ') || '—'],
                ['data access', tool.dataAccess.join(', ') || '—'],
                ['timeout', tool.timeoutMs === null ? 'the executor default' : tool.timeoutMs + ' ms'],
                ['required arguments', tool.requiredArguments.join(', ') || 'none'],
                ['held by', tool.heldBy.join(', ') || 'no profile'],
              ]),
              json(tool.inputSchema, 'input schema'),
            ]);
          }),
        ]),
      ]);
    });
  }

  /* ── Policies ──────────────────────────────────────────────────────────── */

  function renderPolicies() {
    return api('/policies').then(function (body) {
      return fragment([
        el('section', { class: 'block' }, [
          el('h2', { text: 'Decision model' }),
          kv([
            ['decisions', body.evaluate.decisions.join(', ')],
            ['when no rule matches', body.defaultDecision + ' (fail closed)'],
            ['rule kinds', body.evaluate.ruleKinds.join(', ')],
            ['semantics', body.evaluate.kind],
          ]),
          el('ul', { class: 'notes' }, body.notes.map(function (note) {
            return el('li', { text: note });
          })),
        ]),
        el('section', { class: 'block' }, [
          el('h2', { text: 'SVC boundaries (frozen configuration, not environment)' }),
          table(
            'Boundaries',
            ['agent', 'summary', 'source'],
            body.boundaries.map(function (boundary) {
              return [boundary.agentId, boundary.summary, boundary.source];
            }),
          ),
          body.boundaries.map(function (boundary) {
            return el('details', null, [
              el('summary', { text: boundary.agentId + ' boundary object' }),
              json(boundary.boundary, boundary.agentId + ' BOUNDARIES'),
              json(boundary.actionPolicy, boundary.agentId + ' actionPolicy'),
            ]);
          }),
          el('p', { class: 'prose', text:
            'Agents without a boundary entry: ' + (body.withoutBoundary.join(', ') || 'none') + '. ' +
            'They run under the generic kernel alone, so any disposition no rule authorises is refused.' }),
        ]),
        el('section', { class: 'block' }, [
          el('h2', { text: 'Policy rules (' + body.ruleCount + ')' }),
          table(
            'Rules, in evaluation order (higher priority first)',
            ['priority', 'rule', 'kind', 'what it decides'],
            body.rules.map(function (rule) {
              return [rule.priority, rule.id, rule.kind, rule.description];
            }),
            { numeric: [0] },
          ),
          el('p', { class: 'prose', text:
            'The worst (most restrictive) verdict of every applicable rule wins. A rule that throws is treated as a ' +
            'DENY, so a bug in a rule cannot open a path.' }),
        ]),
      ]);
    });
  }

  /* ── Runs ──────────────────────────────────────────────────────────────── */

  function runLink(runId) {
    return el('a', { href: '#/runs/' + encodeURIComponent(runId), text: runId });
  }

  function decisionBlock(detail) {
    if (detail.decision) {
      return json(detail.decision, 'decision the run reached', true);
    }
    if (detail.output) {
      return el('div', null, [el('p', { class: 'note', text: 'No structured decision: the run did not reach a disposition JSON.' }), el('pre', { text: String(detail.output) })]);
    }
    return stateBlock('empty', 'No decision recorded. A run that stops at a gate produces an approval instead of a disposition.');
  }

  function runDetail(detail) {
    var run = detail.run;
    var nodes = [
      el('h2', { text: 'Run ' + run.runId }),
      kv([
        ['status', run.status + (run.terminal ? ' (terminal)' : ' (not terminal)')],
        ['phase', show(run.phase)],
        ['agent', run.agentId],
        ['task type', show(run.taskType)],
        ['mode', show(run.mode)],
        ['session', show(run.sessionId)],
        ['started', show(run.startedIso)],
        ['ended', show(run.finishedIso)],
        ['duration', typeof run.durationMs === 'number' ? run.durationMs + ' ms' : '—'],
        ['reason', show(run.reason)],
        ['trace root', show(run.traceRoot)],
        ['events', detail.eventCount],
        ['live in this process', detail.live ? 'yes' : 'no'],
      ]),
    ];

    nodes.push(el('h3', { text: 'Decision' }));
    nodes.push(decisionBlock(detail));

    nodes.push(el('h3', { text: 'State timeline' }));
    nodes.push(detail.stateTimeline.length
      ? el('ol', { class: 'timeline' }, detail.stateTimeline.map(function (entry) {
          return el('li', null, [el('strong', { text: entry.from + ' → ' + entry.to }), ' at ' + show(entry.iso), json(entry.meta, 'transition metadata')]);
        }))
      : stateBlock('empty', 'No state transitions were recorded for this run.'));

    nodes.push(el('h3', { text: 'Policy decisions' }));
    nodes.push(detail.policyDecisions.length
      ? table(
          'Every verdict the kernel returned, in order',
          ['seq', 'time', 'kind', 'subject', 'decision', 'rule', 'reason'],
          detail.policyDecisions.map(function (decision) {
            return [
              decision.seq,
              show(decision.iso),
              show(decision.kind),
              show(decision.tool || decision.action),
              el('span', { class: 'badge tone-' + (decision.decision === 'ALLOW' ? 'allow' : decision.decision === 'DENY' ? 'deny' : 'wait'), text: decision.decision }),
              show(decision.rule),
              show(decision.reason),
            ];
          }),
          { numeric: [0] },
        )
      : stateBlock('empty', 'No policy verdict was recorded.'));

    nodes.push(el('h3', { text: 'Tool calls' }));
    nodes.push(detail.toolCalls.length
      ? table(
          'Every tool proposal, its verdict and its outcome',
          ['tool', 'status', 'verdict', 'rule', 'duration', 'approval', 'detail'],
          detail.toolCalls.map(function (call_) {
            var extra = [];
            if (call_.args) extra.push(json(call_.args, 'arguments'));
            if (call_.error) extra.push(json(call_.error, 'error'));
            if (call_.result) extra.push(json(call_.result, 'result'));
            return [
              call_.tool,
              call_.status,
              show(call_.policyDecision),
              show(call_.policyRule),
              typeof call_.durationMs === 'number' ? call_.durationMs + ' ms' : '—',
              call_.approvalId || '—',
              extra.length ? el('div', null, extra) : '—',
            ];
          }),
        )
      : stateBlock('empty', 'This run proposed no tool calls.'));

    nodes.push(el('h3', { text: 'Approvals bound to this run' }));
    nodes.push(detail.approvals.length
      ? table(
          'Approvals',
          ['approval', 'status', 'tool', 'reason', 'created', 'resolved by', 'resolved at', 'note'],
          detail.approvals.map(function (approval) {
            return [
              approval.approvalId,
              approval.status,
              show(approval.toolName),
              show(approval.reason),
              show(approval.createdIso),
              show(approval.resolvedBy),
              show(approval.resolvedIso),
              show(approval.resolutionNote),
            ];
          }),
        )
      : stateBlock('empty', 'No approval is bound to this run.'));

    nodes.push(el('h3', { text: 'Audit rows' }));
    nodes.push(detail.audit.length
      ? table(
          'Durable audit rows for this run',
          ['type', 'time', 'status', 'reason'],
          detail.audit.map(function (row) {
            return [row.type, show(row.iso), show(row.status), show(row.reason)];
          }),
        )
      : stateBlock('empty', 'No audit row recorded.'));

    nodes.push(el('h3', { text: 'Trace' }));
    nodes.push(detail.trace
      ? fragment([
          table(
            'Spans, outermost first',
            ['span', 'type', 'status', 'duration', 'children'],
            detail.trace.spans.map(function (span) {
              return [
                el('span', { text: '\u00a0\u00a0'.repeat(span.depth) + span.name }),
                show(span.type),
                show(span.status),
                typeof span.durationMs === 'number' ? span.durationMs + ' ms' : '—',
                span.childCount,
              ];
            }),
            { numeric: [3, 4] },
          ),
          json(detail.trace.full, 'the full trace tree'),
        ])
      : stateBlock('empty', 'No trace was persisted for this run.'));

    if (!run.terminal) {
      var cancelButton = el('button', { type: 'submit', text: 'Cancel this run' });
      var cancelForm = el('form', { class: 'inline', id: 'cancel-form' }, [cancelButton]);
      cancelForm.addEventListener('submit', function (event) {
        event.preventDefault();
        cancelButton.disabled = true;
        post('/runs/' + encodeURIComponent(run.runId) + '/cancel', { reason: 'cancelled from the operator console' })
          .then(function () { return render(); })
          .catch(function (error) {
            cancelButton.disabled = false;
            viewRoot.prepend(errorBlock(error));
          });
      });
      nodes.push(el('h3', { text: 'Actions' }));
      nodes.push(el('p', { class: 'prose', text:
        'Cancelling writes a CANCELLED row and an audit entry. A run that is in flight in the server process stops ' +
        'at its next iteration; a call already dispatched finishes.' }));
      nodes.push(cancelForm);
    }

    nodes.push(el('h3', { text: 'Raw events' }));
    nodes.push(el('p', { class: 'hint', text: detail.eventCount + ' events, ordered by the bus sequence. Expand to read them.' }));
    nodes.push(el('p', null, [el('a', { href: API + '/runs/' + encodeURIComponent(run.runId) + '/events', text: 'Open the events endpoint as JSON' })]));

    return el('section', { class: 'block' }, nodes);
  }

  function renderRuns(route) {
    var query = '/runs?limit=100' + (state.runAgentFilter ? '&agentId=' + encodeURIComponent(state.runAgentFilter) : '');
    return api(query).then(function (body) {
      var selectedId = route.param || (body.runs.length ? body.runs[0].runId : null);
      var filterSelect = el('select', { id: 'run-filter' }, [
        el('option', { value: '', text: 'all agents' }),
        el('option', { value: 'svc_03', text: 'svc_03' }),
        el('option', { value: 'svc_04', text: 'svc_04' }),
        el('option', { value: 'svc_06', text: 'svc_06' }),
        el('option', { value: 'general', text: 'general' }),
      ]);
      filterSelect.value = state.runAgentFilter;
      filterSelect.addEventListener('change', function () {
        state.runAgentFilter = filterSelect.value;
        render();
      });

      var listColumn = el('section', { class: 'block' }, [
        el('h2', { text: 'Runs (' + body.count + ' of ' + body.total + ')' }),
        el('p', { class: 'note', text: body.note }),
        el('label', { for: 'run-filter', text: 'Filter by agent' }),
        filterSelect,
        body.runs.length
          ? table(
              'Persisted runs, newest first',
              ['run', 'agent', 'status', 'started', 'duration', 'tools'],
              body.runs.map(function (run) {
                return [
                  runLink(run.runId),
                  run.agentId,
                  run.terminal ? run.status : run.status + ' (open)',
                  show(run.startedIso),
                  typeof run.durationMs === 'number' ? run.durationMs + ' ms' : '—',
                  (run.toolCalls || []).join(', ') || '—',
                ];
              }),
            )
          : stateBlock('empty', 'No run has been started yet. Start one from the Agents view.'),
      ]);

      var detailColumn = el('section', { class: 'block' }, [el('p', { class: 'state loading', text: 'Loading run detail…' })]);
      var pending = selectedId
        ? api('/runs/' + encodeURIComponent(selectedId))
            .then(function (detail) { return runDetail(detail); })
            .catch(function (error) { return errorBlock(error); })
        : Promise.resolve(stateBlock('empty', 'Select a run from the list to read its record.'));

      return pending.then(function (detailNode) {
        detailColumn.replaceChildren(detailNode);
        return fragment([el('div', { class: 'columns' }, [listColumn, detailColumn])]);
      });
    });
  }

  /* ── Approvals ─────────────────────────────────────────────────────────── */

  function operatorField() {
    return el('p', null, [
      el('label', { for: 'operator', text: 'Resolving as (recorded in the approval row)' }),
      el('input', { id: 'operator', type: 'text', autocomplete: 'off', value: 'operator' }),
    ]);
  }

  function approvalAction(approval, action) {
    var button = el('button', { type: 'submit', text: action === 'approve' ? 'Approve' : 'Reject' });
    var form = el('form', { class: 'inline' }, [button]);
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var operatorInput = document.getElementById('operator');
      var resolvedBy = operatorInput && operatorInput.value.trim() ? operatorInput.value.trim() : 'operator';
      button.disabled = true;
      post('/approvals/' + encodeURIComponent(approval.approvalId) + '/' + action, { resolvedBy: resolvedBy })
        .then(function () { return render(); })
        .catch(function (error) {
          button.disabled = false;
          viewRoot.prepend(errorBlock(error));
        });
    });
    return form;
  }

  function renderApprovals() {
    return Promise.all([api('/approvals?status=pending'), api('/approvals?status=all')]).then(function (results) {
      var pending = results[0];
      var all = results[1];

      var queue = pending.approvals.length
        ? table(
            'Pending approvals, oldest first — each one is bound to one tool call',
            ['approval', 'agent', 'tool', 'run', 'reason', 'created', 'expires', 'proposal', 'decision'],
            pending.approvals.map(function (approval) {
              return [
                approval.approvalId,
                approval.agentId,
                show(approval.toolName),
                approval.runId ? runLink(approval.runId) : '—',
                show(approval.reason),
                show(approval.createdIso),
                show(approval.expiresIso),
                json({ args: approval.args, payload: approval.payload, fingerprint: approval.requestFingerprint }, 'what was proposed'),
                el('div', null, [approvalAction(approval, 'approve'), approvalAction(approval, 'reject')]),
              ];
            }),
          )
        : stateBlock('empty', 'Nothing is waiting for a human. A run pauses here only when a tool call is gated.');

      var resolved = all.approvals.filter(function (approval) { return approval.status !== 'pending'; });

      return fragment([
        el('section', { class: 'block' }, [
          el('h2', { text: 'Approval queue' }),
          kv([
            ['pending', all.countsByStatus.pending],
            ['approved', all.countsByStatus.approved],
            ['rejected', all.countsByStatus.rejected],
            ['expired', all.countsByStatus.expired],
            ['cancelled', all.countsByStatus.cancelled],
            ['total', all.total],
          ]),
          el('p', { class: 'note', text: all.pendingNote }),
          operatorField(),
          queue,
        ]),
        el('section', { class: 'block' }, [
          el('h2', { text: 'Resolution history (' + resolved.length + ')' }),
          resolved.length
            ? table(
                'Resolved approvals, newest first',
                ['approval', 'status', 'agent', 'tool', 'run', 'created', 'resolved by', 'resolved at', 'note'],
                resolved.map(function (approval) {
                  return [
                    approval.approvalId,
                    approval.status,
                    approval.agentId,
                    show(approval.toolName),
                    approval.runId ? runLink(approval.runId) : '—',
                    show(approval.createdIso),
                    show(approval.resolvedBy),
                    show(approval.resolvedIso),
                    show(approval.resolutionNote),
                  ];
                }),
                { numeric: [] },
              )
            : stateBlock('empty', 'No approval has been resolved yet.'),
        ]),
        el('section', { class: 'block' }, [
          el('h2', { text: 'What happens after a decision' }),
          el('p', { class: 'prose', text:
            'Resolution is recorded in the approval log; it does not by itself execute anything. The gated call runs ' +
            'when a run re-proposes it with this approval id — start that run from the Agents view and put the ' +
            'approval id in the resume field. The executor then re-checks the tool name and an argument fingerprint ' +
            'before it calls the tool.' }),
        ]),
      ]);
    });
  }

  /* ── Evaluations ───────────────────────────────────────────────────────── */

  function fixtureLine(label, fixture) {
    if (!fixture) return label + ': —';
    return label + ': ' + fixture.taskCorrect + '/' + fixture.cases + ' reached the expected action, ' +
      fixture.passed + ' passing assertions, ' + fixture.failed + ' failing, ' + fixture.totalTokens + ' tokens';
  }

  function renderEvaluations() {
    return api('/evaluations').then(function (body) {
      if (!body.available) {
        return fragment([
          el('section', { class: 'block' }, [
            el('h2', { text: 'Runtime evaluation' }),
            stateBlock('empty', 'No report has been written yet.'),
            kv([
              ['expected path', body.path],
              ['command', el('code', { text: body.command })],
              ['oracle-only command', el('code', { text: body.oracleOnlyCommand })],
              ['unreadable', show(body.unreadable)],
              ['error', show(body.error)],
            ]),
            el('p', { class: 'prose', text: body.note }),
          ]),
        ]);
      }

      return fragment([
        el('section', { class: 'block' }, [
          el('h2', { text: 'Runtime evaluation' }),
          kv([
            ['generated', show(body.generatedAt)],
            ['mode', show(body.mode)],
            ['report path', body.path],
            ['agents', body.totals.agents],
            ['agents failing their gate', body.totals.agentsFailingGate],
            ['oracle: expected action reached', body.totals.oracleCorrect + '/' + body.totals.oracleCases],
            ['oracle: failing assertions', body.totals.oracleFailedAssertions],
            ['naive fixture: expected action reached', body.totals.naiveCorrect + '/' + body.totals.naiveCases],
          ]),
          el('p', { class: 'note', text: body.fixtureNote }),
          el('p', { class: 'prose', text: body.statement }),
        ]),
        el('section', { class: 'block' }, [
          el('h2', { text: 'Per agent' }),
          table(
            'Gate verdict per agent',
            ['agent', 'dataset', 'gate', 'oracle', 'naive fixture', 'suites with no cases'],
            body.agents.map(function (agent) {
              return [
                agent.agentId,
                agent.hasDataset ? 'yes' : 'no',
                agent.gate && agent.gate.ok ? 'ok' : 'FAIL',
                fixtureLine('oracle', agent.oracle),
                fixtureLine('naive', agent.naive),
                agent.emptySuites.join(', ') || '—',
              ];
            }),
          ),
          body.agents.map(function (agent) {
            return el('details', null, [
              el('summary', { text: agent.agentId + ' — suite coverage' }),
              table(
                agent.agentId + ' suites',
                ['suite', 'cases', 'passed', 'failed', 'skipped', 'coverage', 'needs a live model'],
                agent.suites.map(function (suite) {
                  return [
                    suite.title ? suite.title + ' (' + suite.name + ')' : suite.name,
                    suite.totals.cases,
                    suite.totals.passed,
                    suite.totals.failed,
                    suite.totals.skipped,
                    show(suite.coverage),
                    suite.requiresLiveModel ? 'yes' : 'no',
                  ];
                }),
                { numeric: [1, 2, 3, 4] },
              ),
              agent.gate && agent.gate.note ? el('p', { class: 'note', text: agent.gate.note }) : null,
            ]);
          }),
        ]),
        el('section', { class: 'block' }, [
          el('h2', { text: 'What this measures' }),
          el('p', { class: 'prose', text: body.requiresLiveModel }),
        ]),
      ]);
    });
  }

  /* ── routing ───────────────────────────────────────────────────────────── */

  var VIEWS = {
    agents: renderAgents,
    runs: renderRuns,
    approvals: renderApprovals,
    tools: renderTools,
    policies: renderPolicies,
    evaluations: renderEvaluations,
  };

  function parseHash() {
    var raw = String(window.location.hash || '').replace(/^#\/?/, '');
    var parts = raw.split('/').filter(function (part) { return part !== ''; });
    return { name: parts[0] || 'agents', param: parts[1] || null };
  }

  function render() {
    var route = parseHash();
    var name = Object.prototype.hasOwnProperty.call(VIEWS, route.name) ? route.name : 'agents';
    navLinks.forEach(function (link) {
      if (link.dataset.view === name) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    if (statusLine) statusLine.textContent = 'Loading the ' + name + ' view…';
    viewRoot.replaceChildren(stateBlock('loading', 'Loading…'));
    return Promise.resolve()
      .then(function () { return VIEWS[name](route); })
      .then(function (node) { viewRoot.replaceChildren(node); })
      .catch(function (error) {
        if (statusLine) statusLine.textContent = 'Request failed' + (error.requestId ? ' (request ' + error.requestId + ')' : '') + '.';
        viewRoot.replaceChildren(errorBlock(error));
      });
  }

  window.addEventListener('hashchange', render);
  if (refreshButton) {
    refreshButton.addEventListener('click', function () {
      render();
    });
  }

  render();
})();
