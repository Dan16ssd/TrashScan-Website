(function () {
  const token = localStorage.getItem('trashscan_token');
  if (!token) {
    window.location.href = '/admin-login.html';
    return;
  }

  // Verify token is still valid by trying to load bins
  const authHeaders = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };

  // ── Logout ─────────────────────────────────────────────────────────────────
  document.getElementById('btn-logout').addEventListener('click', (e) => {
    e.preventDefault();
    localStorage.removeItem('trashscan_token');
    window.location.href = '/admin-login.html';
  });

  // ── Load bins ──────────────────────────────────────────────────────────────
  async function loadBins() {
    try {
      const resp = await fetch('/api/admin/bins', { headers: authHeaders });
      if (resp.status === 401) { logout(); return; }
      const binState = await resp.json();
      renderBins(binState);
    } catch (err) {
      console.error('Failed to load bins:', err);
    }
  }

  function renderBins(binState) {
    const container = document.getElementById('admin-bins-list');
    const bins = Object.values(binState);
    if (!bins.length) {
      container.innerHTML = '<p style="color:var(--muted);">No bins configured.</p>';
      return;
    }

    container.innerHTML = bins.map(bin => {
      const statusClass = bin.status === 'full' ? 'badge-no' : bin.status === 'warning' ? 'badge-warn' : 'badge-yes';
      const statusText  = bin.status === 'full' ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="vertical-align:-2px; margin-right:3px;"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/><line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="12" y1="17" x2="12.01" y2="17" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>FULL' : bin.status === 'warning' ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="vertical-align:-2px; margin-right:3px;"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M12 8v4M12 16h.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>Warning' : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="vertical-align:-2px; margin-right:3px;"><polyline points="20 6 9 17 4 12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>OK';
      return `
        <div class="admin-bin-row" data-id="${esc(bin.id)}">
          <div class="admin-bin-header">
            <strong>${esc(bin.name)}</strong>
            <span class="badge ${statusClass}">${statusText}</span>
          </div>
          <div class="admin-bin-fields">
            <label>Location
              <input type="text" class="field-location" value="${esc(bin.location)}"
                style="padding:6px 10px; border:1px solid #cde; border-radius:6px; width:100%;" />
            </label>
            <label>Fill Level (%)
              <input type="number" class="field-fill" value="${bin.fillLevel}" min="0" max="100"
                style="padding:6px 10px; border:1px solid #cde; border-radius:6px; width:100%;" />
            </label>
            <div style="display:flex; gap:8px; align-items:flex-end;">
              <button class="btn btn-primary btn-update" style="padding:8px 16px;">Update</button>
              <button class="btn btn-danger btn-delete" style="padding:8px 16px;">Delete</button>
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Attach events
    container.querySelectorAll('.admin-bin-row').forEach(row => {
      const id = row.dataset.id;

      row.querySelector('.btn-update').addEventListener('click', async () => {
        const location  = row.querySelector('.field-location').value;
        const fillLevel = row.querySelector('.field-fill').value;
        await fetch(`/api/admin/bins/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: authHeaders,
          body: JSON.stringify({ location, fillLevel: Number(fillLevel) }),
        });
        loadBins();
        loadLogs();
      });

      row.querySelector('.btn-delete').addEventListener('click', async () => {
        if (!confirm(`Delete bin "${id}"?`)) return;
        await fetch(`/api/admin/bins/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: authHeaders,
        });
        loadBins();
      });
    });
  }

  // ── Add new bin ────────────────────────────────────────────────────────────
  document.getElementById('btn-add-bin').addEventListener('click', async () => {
    const id       = document.getElementById('new-bin-id').value.trim();
    const name     = document.getElementById('new-bin-name').value.trim();
    const location = document.getElementById('new-bin-location').value.trim();
    const errEl    = document.getElementById('add-bin-error');
    errEl.textContent = '';
    errEl.classList.remove('visible');

    if (!id || !name || !location) {
      errEl.textContent = 'All fields are required.';
      errEl.classList.add('visible');
      return;
    }

    const resp = await fetch('/api/admin/bins', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ id, name, location }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      errEl.textContent = data.error || 'Failed to add bin.';
      errEl.classList.add('visible');
      return;
    }

    document.getElementById('new-bin-id').value = '';
    document.getElementById('new-bin-name').value = '';
    document.getElementById('new-bin-location').value = '';
    loadBins();
  });

  // ── Load logs + analytics ──────────────────────────────────────────────────
  async function loadLogs() {
    try {
      const resp = await fetch('/api/admin/logs', { headers: authHeaders });
      if (resp.status === 401) { logout(); return; }
      const { history, analytics } = await resp.json();

      document.getElementById('stat-total').textContent        = analytics.totalScansToday;
      document.getElementById('stat-top-material').textContent = analytics.topMaterial
        ? `${analytics.topMaterial} (${analytics.topMaterialPercent}%)`
        : '—';
      document.getElementById('stat-capacity').textContent     = analytics.binsAtCapacity;

      const listEl = document.getElementById('scan-history-list');
      if (!history.length) {
        listEl.innerHTML = '<p style="color:var(--muted);">No history yet.</p>';
        return;
      }
      listEl.innerHTML = history.map(entry => `
        <div class="log-entry">
          <span class="log-time">${new Date(entry.timestamp).toLocaleTimeString()}</span>
          <span class="log-msg">— <strong>${esc(entry.binName || entry.binId)}</strong>:
            ${esc(entry.object || entry.material || '—')} (${esc(entry.action)})</span>
        </div>
      `).join('');
    } catch (err) {
      console.error('Failed to load logs:', err);
    }
  }

  // ── Map scan moderation ──────────────────────────────────────────────────────
  async function loadMapScans() {
    const listEl = document.getElementById('map-scans-list');
    if (!listEl) return;
    try {
      const resp = await fetch('/api/admin/scans', { headers: authHeaders });
      if (resp.status === 401) { logout(); return; }
      const { scans, error } = await resp.json();

      if (error || !scans || !scans.length) {
        listEl.innerHTML = '<p style="color:var(--muted);">' + esc(error || 'No map scans yet.') + '</p>';
        return;
      }

      listEl.innerHTML = scans.map(scan => `
        <div class="log-entry" data-scan-id="${esc(scan.id)}" style="display:flex; align-items:center; gap:10px;">
          <span class="log-time">${scan.timestamp ? new Date(scan.timestamp).toLocaleString() : '—'}</span>
          <span class="log-msg" style="flex:1;">
            <strong>${esc(scan.item_name || '—')}</strong> · ${esc(scan.category || '—')}
            · ${esc(scan.location_name || 'Unknown')} · ${esc(scan.user_id)}
            ${scan.in_use ? '<span class="badge badge-warn" style="margin-left:6px;">in use — hidden from map</span>' : ''}
          </span>
          <button class="btn btn-danger btn-delete-scan" style="padding:4px 12px; font-size:0.8rem;">Delete</button>
        </div>
      `).join('');

      listEl.querySelectorAll('.btn-delete-scan').forEach(btn => {
        btn.addEventListener('click', async () => {
          const row = btn.closest('[data-scan-id]');
          const id  = row.dataset.scanId;
          if (!confirm('Remove this scan from the map?')) return;
          const resp = await fetch(`/api/admin/scans/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers: authHeaders,
          });
          if (resp.ok) {
            row.remove();
          } else {
            const data = await resp.json().catch(() => ({}));
            alert(data.error || 'Failed to delete scan.');
          }
        });
      });
    } catch (err) {
      console.error('Failed to load map scans:', err);
      listEl.innerHTML = '<p style="color:var(--muted);">Could not load map scans.</p>';
    }
  }

  function logout() {
    localStorage.removeItem('trashscan_token');
    window.location.href = '/admin-login.html';
  }

  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Initial load
  loadBins();
  loadLogs();
  loadMapScans();

  // Bin state changes (scans, admin edits) no longer push over a socket —
  // poll instead so this works on serverless hosting with no persistent
  // connections.
  setInterval(() => {
    loadBins();
    loadLogs();
  }, 10000);
})();
