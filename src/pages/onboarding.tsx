{step === 0 && (
  <div>
    {/* Wordmark */}
    <div style={{ textAlign: 'center', marginBottom: '28px' }}>
      <div style={{
        fontFamily: "'Playfair Display', Georgia, serif",
        fontSize: 'clamp(28px, 8vw, 38px)', fontWeight: '900',
        color: '#F5F1EA', letterSpacing: '-0.5px',
        lineHeight: '1', marginBottom: '4px'
      }}>Morning</div>
      <div style={{
        fontFamily: "'Playfair Display', Georgia, serif",
        fontSize: 'clamp(28px, 8vw, 38px)', fontWeight: '900',
        fontStyle: 'italic', color: '#C8A45A',
        letterSpacing: '-0.5px', lineHeight: '1',
        marginBottom: '20px'
      }}>Brief</div>
      <div style={{
        fontFamily: "'DM Mono', monospace", fontSize: '11px',
        letterSpacing: '4px', color: '#C8A45A',
        textTransform: 'uppercase'
      }}>WELCOME</div>
    </div>

    <h2 style={{ ...headStyle, textAlign: 'center', marginBottom: '6px' }}>
      Choose your brief
    </h2>
    <p style={{ ...subStyle, textAlign: 'center' }}>
      Tap a column to select. You can change this later.
    </p>

    {/* Comparison table */}
    <div style={{
      border: '1px solid #2A2A2A', borderRadius: '4px',
      overflow: 'hidden', marginBottom: '24px'
    }}>

      {/* Column headers — tappable */}
      <div style={{ display: 'flex', borderBottom: '2px solid #2A2A2A' }}>
        {/* Row label spacer */}
        <div style={{ width: '110px', flexShrink: 0, borderRight: '1px solid #2A2A2A' }} />

        {/* Standard header */}
        <button
          onClick={() => setBriefType('standard')}
          style={{
            flex: 1, padding: '14px 8px',
            background: briefType === 'standard' ? 'rgba(200,164,90,0.1)' : '#1E1E1E',
            borderRight: '1px solid #2A2A2A',
            border: 'none', cursor: 'pointer',
            borderBottom: briefType === 'standard' ? '2px solid #C8A45A' : '2px solid transparent'
          }}>
          <div style={{
            fontFamily: "'Playfair Display', Georgia, serif",
            fontSize: '14px', fontWeight: '700',
            color: briefType === 'standard' ? '#C8A45A' : '#F5F1EA',
            marginBottom: '4px'
          }}>Standard</div>
          <div style={{
            fontFamily: "'DM Mono', monospace", fontSize: '8px',
            letterSpacing: '1px', color: '#555'
          }}>NO SETUP</div>
        </button>

        {/* Personalised header */}
        <button
          onClick={() => setBriefType('personalised')}
          style={{
            flex: 1, padding: '14px 8px',
            background: briefType === 'personalised' ? 'rgba(200,164,90,0.1)' : '#1E1E1E',
            border: 'none', cursor: 'pointer',
            borderBottom: briefType === 'personalised' ? '2px solid #C8A45A' : '2px solid transparent'
          }}>
          <div style={{
            fontFamily: "'Playfair Display', Georgia, serif",
            fontSize: '14px', fontWeight: '700',
            color: briefType === 'personalised' ? '#C8A45A' : '#F5F1EA',
            marginBottom: '4px'
          }}>Personalised</div>
          <div style={{
            fontFamily: "'DM Mono', monospace", fontSize: '8px',
            letterSpacing: '1px', color: '#555'
          }}>3 MIN SETUP</div>
        </button>
      </div>

      {/* Comparison rows */}
      {[
        { label: 'Top stories', standard: '✓', personalised: '✓' },
        { label: 'India news', standard: '✓', personalised: '✓' },
        { label: 'Markets', standard: '✓', personalised: '✓' },
        { label: 'Your city', standard: '—', personalised: '✓' },
        { label: 'Your industry', standard: '—', personalised: '✓' },
        { label: 'Your interests', standard: '—', personalised: '✓' },
        { label: 'Tone control', standard: '—', personalised: '✓' },
        { label: 'Reading depth', standard: '—', personalised: '✓' },
      ].map((r, i) => (
        <div key={r.label} style={{
          display: 'flex',
          borderBottom: i < 7 ? '1px solid #222' : 'none',
          background: i % 2 === 0 ? '#1A1A1A' : '#1E1E1E'
        }}>
          {/* Row label */}
          <div style={{
            width: '110px', flexShrink: 0,
            padding: '11px 12px',
            borderRight: '1px solid #2A2A2A',
            fontFamily: "'DM Sans', sans-serif",
            fontSize: '12px', color: '#666',
            display: 'flex', alignItems: 'center'
          }}>{r.label}</div>

          {/* Standard value */}
          <div
            onClick={() => setBriefType('standard')}
            style={{
              flex: 1, padding: '11px 8px',
              borderRight: '1px solid #2A2A2A',
              background: briefType === 'standard' ? 'rgba(200,164,90,0.05)' : 'transparent',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer'
            }}>
            <span style={{
              fontFamily: "'DM Mono', monospace", fontSize: '13px',
              color: r.standard === '✓' ? '#C8A45A' : '#333',
              fontWeight: r.standard === '✓' ? '700' : '400'
            }}>{r.standard}</span>
          </div>

          {/* Personalised value */}
          <div
            onClick={() => setBriefType('personalised')}
            style={{
              flex: 1, padding: '11px 8px',
              background: briefType === 'personalised' ? 'rgba(200,164,90,0.05)' : 'transparent',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer'
            }}>
            <span style={{
              fontFamily: "'DM Mono', monospace", fontSize: '13px',
              color: r.personalised === '✓' ? '#C8A45A' : '#333',
              fontWeight: r.personalised === '✓' ? '700' : '400'
            }}>{r.personalised}</span>
          </div>
        </div>
      ))}
    </div>

    {/* CTA — only appears after selection */}
    {briefType && (
      <button
        onClick={next}
        disabled={saving}
        style={btnPrimary}
      >
        {saving ? 'Setting up...' :
          briefType === 'standard' ? 'Start Reading →' : 'Set Up My Profile →'}
      </button>
    )}
  </div>
)}