/* ==========================================================================
   Audio Import, Playback & Transcription
   ========================================================================== */

async function transcribeAudioWithChunking(audioFile, language, apiKey, transcribeModel, signal, onChunkSegments) {
  var knownDuration = getLoadedAudioDurationSec();
  var fitsDirectSize = audioFile.size <= MAX_DIRECT_UPLOAD_BYTES;
  var supportsServerChunking = transcribeModelSupportsServerChunking(transcribeModel);
  var serverChunkingDurationFallback = false;

  if (fitsDirectSize && supportsServerChunking) {
    try {
      return await transcribeAudio(audioFile, language, apiKey, transcribeModel, signal);
    } catch (err) {
      if (!isTranscriptionDurationLimitError(err)) throw err;
      serverChunkingDurationFallback = true;
      showToast('서버 청크 처리 한도를 넘어 클라이언트 청크로 재시도합니다.');
    }
  }

  // 파일 크기와 재생 시간이 모두 안전할 때만 직접 전송한다.
  if (!serverChunkingDurationFallback && fitsDirectSize && (knownDuration === null || knownDuration <= MAX_DIRECT_TRANSCRIBE_DURATION_SEC)) {
    return transcribeAudio(audioFile, language, apiKey, transcribeModel, signal);
  }

  if (!fitsDirectSize) {
    showToast('파일이 커서 청크 분할 모드로 처리합니다.');
  } else if (knownDuration !== null && knownDuration > MAX_DIRECT_TRANSCRIBE_DURATION_SEC) {
    showToast('오디오가 길어서 청크 분할 모드로 처리합니다.');
  } else {
    showToast('오디오 길이를 확인합니다.');
  }

  // 1. ArrayBuffer로 읽기
  setPlayerBadgeState('transcribing', '오디오 길이 확인 중...');
  showTranscribeProgress('오디오 길이 확인 중...', null);
  if (signal && signal.aborted) throw new DOMException('전사가 취소되었습니다.', 'AbortError');
  var arrayBuffer = await audioFile.arrayBuffer();
  if (signal && signal.aborted) throw new DOMException('전사가 취소되었습니다.', 'AbortError');

  // 2. AudioContext로 디코딩
  var tempCtx = new (window.AudioContext || window.webkitAudioContext)();
  var audioBuffer = await tempCtx.decodeAudioData(arrayBuffer);
  await tempCtx.close();
  if (signal && signal.aborted) throw new DOMException('전사가 취소되었습니다.', 'AbortError');

  if (fitsDirectSize && audioBuffer.duration <= MAX_DIRECT_TRANSCRIBE_DURATION_SEC) {
    showTranscribeProgress('전사 중...', null);
    return transcribeAudio(audioFile, language, apiKey, transcribeModel, signal);
  }

  // 3. OfflineAudioContext로 16kHz mono 리샘플링
  setPlayerBadgeState('transcribing', '오디오 처리 중...');
  showTranscribeProgress('오디오 청크 준비 중...', null);
  var resampledBuffer = await resampleToMono16k(audioBuffer);
  if (signal && signal.aborted) throw new DOMException('전사가 취소되었습니다.', 'AbortError');

  // 4. 청크 수 계산 및 순차 전사
  var totalDuration = resampledBuffer.duration;
  var totalChunks = Math.ceil(totalDuration / CHUNK_DURATION_SEC);
  var allSegments = [];
  var contextPrompt = '';

  for (var i = 0; i < totalChunks; i++) {
    if (signal && signal.aborted) throw new DOMException('전사가 취소되었습니다.', 'AbortError');
    var startSec = i * CHUNK_DURATION_SEC;
    var endSec = Math.min((i + 1) * CHUNK_DURATION_SEC, totalDuration);
    var offsetSec = startSec;

    var chunkPct = Math.round((i / totalChunks) * 100);
    setPlayerBadgeState('transcribing', '청크 ' + (i + 1) + '/' + totalChunks + ' 전사 중...');
    showTranscribeProgress('청크 ' + (i + 1) + ' / ' + totalChunks + ' 전사 중...', chunkPct);

    var wavBlob = extractChunkAsWav(resampledBuffer, startSec, endSec);
    var wavFile = new File([wavBlob], 'chunk_' + i + '.wav', { type: 'audio/wav' });

    var result = await transcribeAudio(wavFile, language, apiKey, transcribeModel, signal, contextPrompt);

    // 타임스탬프에 청크 오프셋 적용
    var segments = (result.segments || []).map(function (seg) {
      return Object.assign({}, seg, {
        start: (seg.start || 0) + offsetSec,
        end: (seg.end || seg.start || 0) + offsetSec
      });
    });
    allSegments = allSegments.concat(segments);
    if (typeof onChunkSegments === 'function') {
      onChunkSegments(allSegments.slice(), i + 1, totalChunks);
    }

    // 다음 청크의 프롬프트로 직전 전사 마지막 부분 사용 (문맥 연속성)
    if (result.text) {
      var words = result.text.trim().split(' ');
      contextPrompt = words.slice(-30).join(' ');
    }
  }

  return { segments: allSegments };
}



async function resampleToMono16k(audioBuffer) {
  var targetLength = Math.ceil(audioBuffer.duration * WHISPER_SAMPLE_RATE);
  var offlineCtx = new OfflineAudioContext(1, targetLength, WHISPER_SAMPLE_RATE);
  var source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offlineCtx.destination);
  source.start(0);
  return await offlineCtx.startRendering();
}



function extractChunkAsWav(audioBuffer, startSec, endSec) {
  var sampleRate = audioBuffer.sampleRate;
  var startSample = Math.floor(startSec * sampleRate);
  var endSample = Math.min(Math.floor(endSec * sampleRate), audioBuffer.length);
  var samples = audioBuffer.getChannelData(0).subarray(startSample, endSample);
  return float32ToWav(samples, sampleRate);
}



function float32ToWav(samples, sampleRate) {
  var numSamples = samples.length;
  var dataSize = numSamples * 2; // 16-bit PCM
  var buffer = new ArrayBuffer(44 + dataSize);
  var view = new DataView(buffer);

  // RIFF/WAVE 헤더
  wavWriteString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  wavWriteString(view, 8, 'WAVE');
  wavWriteString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);          // fmt chunk size
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);           // block align
  view.setUint16(34, 16, true);          // bits per sample
  wavWriteString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // PCM 샘플 변환 (float32 → int16)
  var offset = 44;
  for (var i = 0; i < numSamples; i++) {
    var s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 32768 : s * 32767, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}



function wavWriteString(view, offset, str) {
  for (var i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}



function setupUploadZone() {
  elements.uploadZone.addEventListener('click', function () {
    elements.fileInput.click();
  });

  elements.fileInput.addEventListener('change', function (e) {
    enqueueAudioFiles(e.target.files);
  });

  ['dragenter', 'dragover'].forEach(function (name) {
    elements.uploadZone.addEventListener(name, function (e) {
      e.preventDefault();
      elements.uploadZone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(function (name) {
    elements.uploadZone.addEventListener(name, function (e) {
      e.preventDefault();
      elements.uploadZone.classList.remove('dragover');
    });
  });

  elements.uploadZone.addEventListener('drop', function (e) {
    enqueueAudioFiles(e.dataTransfer.files);
  });

  elements.btnRemoveFile.addEventListener('click', function (e) {
    e.stopPropagation();
    resetAudioWorkspace();
  });

  elements.btnTranscribe.addEventListener('click', function () {
    triggerTranscribeAI();
  });

  elements.btnCancelTranscribe.addEventListener('click', function () {
    state.batchRunning = false;
    abortCurrentTranscription();
  });
}



function enqueueAudioFiles(fileList) {
  var files = Array.prototype.slice.call(fileList || []).filter(function (file) {
    return file && file.type.startsWith('audio/');
  });

  if (!files.length) {
    if (fileList && fileList.length) showToast('오디오 파일만 업로드할 수 있습니다.');
    return;
  }

  state.fileQueue = files.map(function (file, idx) {
    return { file: file, status: idx === 0 ? 'ready' : 'queued' };
  });
  state.batchRunning = false;
  state.batchIndex = 0;
  state.batchResults = [];
  renderBatchQueue();
  handleAudioImport(files[0], { preserveQueue: true });

  if (files.length > 1) {
    showToast(files.length + '개 파일을 배치 큐에 추가했습니다.');
  }
}



function handleAudioImport(file, options) {
  var preserveQueue = options && options.preserveQueue;
  abortCurrentTranscription();
  releaseAudioObjectUrl();
  if (!preserveQueue) {
    state.fileQueue = [];
    state.batchRunning = false;
    state.batchIndex = 0;
    state.batchResults = [];
    renderBatchQueue();
  }
  state.currentFile = file;
  state.transcriptSourceName = file.name;
  elements.fileName.textContent = file.name;
  elements.fileSize.textContent = formatBytes(file.size);

  elements.uploadZone.classList.add('hidden');
  elements.audioPlayerCard.classList.remove('hidden');
  elements.btnTranscribe.disabled = false;

  state.audioObjectUrl = URL.createObjectURL(file);
  elements.mainAudio.src = state.audioObjectUrl;
  elements.mainAudio.load();

  resetWorkspaceData();
  initWebAudio();

  if (file.size > MAX_DIRECT_UPLOAD_BYTES) {
    showToast('25MB 초과 파일입니다. 청크 분할 모드로 전사합니다.');
  }
}



function resetAudioWorkspace() {
  abortCurrentTranscription();
  clearTranscriptCache();
  state.fileQueue = [];
  state.batchRunning = false;
  state.batchIndex = 0;
  state.batchResults = [];
  stopAudioPlayback();
  state.currentFile = null;
  state.transcriptSourceName = 'transcript';
  elements.fileInput.value = '';
  elements.mainAudio.src = '';
  releaseAudioObjectUrl();
  elements.audioPlayerCard.classList.add('hidden');
  elements.uploadZone.classList.remove('hidden');
  elements.btnTranscribe.disabled = true;
  renderBatchQueue();
  resetWorkspaceData();
}



function releaseAudioObjectUrl() {
  if (state.audioObjectUrl) {
    URL.revokeObjectURL(state.audioObjectUrl);
    state.audioObjectUrl = null;
  }
}



function abortCurrentTranscription() {
  if (state.transcribeAbortController) {
    state.transcribeAbortController.abort();
    state.transcribeAbortController = null;
  }
}



function renderBatchQueue() {
  elements.batchQueue.innerHTML = '';
  if (!state.fileQueue.length || state.fileQueue.length === 1) {
    elements.batchQueue.classList.add('hidden');
    updateTranscribeButtonLabel();
    return;
  }

  elements.batchQueue.classList.remove('hidden');
  var title = document.createElement('div');
  title.className = 'batch-queue-title';
  title.textContent = '파일 큐';
  elements.batchQueue.appendChild(title);

  state.fileQueue.forEach(function (item, idx) {
    var row = document.createElement('div');
    row.className = 'batch-queue-item ' + item.status;

    var name = document.createElement('span');
    name.textContent = (idx + 1) + '. ' + item.file.name;

    var status = document.createElement('span');
    status.className = 'batch-queue-status';
    status.textContent = getBatchStatusLabel(item.status);

    row.appendChild(name);
    row.appendChild(status);
    elements.batchQueue.appendChild(row);
  });
  updateTranscribeButtonLabel();
}



function getBatchStatusLabel(status) {
  if (status === 'running') return '진행 중';
  if (status === 'done') return '완료';
  if (status === 'failed') return '실패';
  if (status === 'ready') return '대기';
  return '큐';
}



function updateTranscribeButtonLabel() {
  var label = state.fileQueue.length > 1 ? '배치 전사 시작 (' + state.fileQueue.length + ')' : 'AI 전사 및 요약 시작';
  elements.btnTranscribe.innerHTML = '<i data-lucide="wand-2"></i> ' + label;
  if (window.lucide) window.lucide.createIcons();
}



function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  var k = 1024;
  var sizes = ['Bytes', 'KB', 'MB'];
  var i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}



function getLoadedAudioDurationSec() {
  var duration = elements.mainAudio ? elements.mainAudio.duration : NaN;
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}



function transcribeModelSupportsServerChunking(model) {
  return (model || 'gpt-4o-transcribe') !== 'whisper-1';
}



function isTranscriptionDurationLimitError(err) {
  var msg = (err && err.message ? err.message : '').toLowerCase();
  return msg.includes('duration') && (msg.includes('longer than') || msg.includes('maximum'));
}



function initWebAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 256;

    // Mobile/iOS: captureStream is poorly supported and adds stream-decoding
    // overhead that can worsen Bluetooth stutter — skip, show sine wave only.
    var isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (!isMobile) {
      try {
        var captureMethod = elements.mainAudio.captureStream || elements.mainAudio.mozCaptureStream;
        if (captureMethod) {
          var stream = captureMethod.call(elements.mainAudio);
          sourceNode = audioCtx.createMediaStreamSource(stream);
          sourceNode.connect(analyserNode);
        }
      } catch (e) {
        // captureStream unsupported or failed — visualizer shows sine wave only
      }
    }
  } catch (e) {
    console.warn('Web Audio init failed:', e);
  }
}



function setupPullToRefresh() {
  var ptr = document.getElementById('pull-to-refresh');
  if (!ptr) return;
  var icon = document.getElementById('ptr-icon');
  var startY = 0;
  var pulling = false;
  var THRESHOLD = 80;
  var MAX_PULL = 120;

  function setPtrY(dist) {
    var t = Math.min(dist / MAX_PULL, 1);
    var y = -72 + t * 88; // -72(hidden) → +16(visible)
    ptr.style.transition = 'none';
    ptr.style.transform = 'translateX(-50%) translateY(' + y + 'px)';
    ptr.classList.add('visible');
    if (icon) icon.style.transform = 'rotate(' + (t * 180) + 'deg)';
  }

  function snapBack() {
    ptr.style.transition = 'transform 0.25s ease, opacity 0.25s ease';
    ptr.style.transform = 'translateX(-50%) translateY(-72px)';
    ptr.classList.remove('ready', 'loading', 'visible');
    if (icon) icon.style.transform = '';
  }

  document.addEventListener('touchstart', function (e) {
    if (window.scrollY <= 0) {
      startY = e.touches[0].clientY;
      pulling = true;
    }
  }, { passive: true });

  document.addEventListener('touchmove', function (e) {
    if (!pulling) return;
    var dist = e.touches[0].clientY - startY;
    if (dist <= 0) { pulling = false; snapBack(); return; }
    setPtrY(Math.min(dist, MAX_PULL));
    ptr.classList.toggle('ready', dist >= THRESHOLD);
  }, { passive: true });

  document.addEventListener('touchend', function () {
    if (!pulling) return;
    pulling = false;
    if (ptr.classList.contains('ready')) {
      ptr.style.transition = 'transform 0.2s ease';
      ptr.style.transform = 'translateX(-50%) translateY(10px)';
      ptr.classList.add('loading');
      if (icon) icon.style.transform = '';
      setTimeout(function () { location.reload(); }, 500);
    } else {
      snapBack();
    }
  });
}



function startVisualizer() {
  var canvas = elements.visualizer;
  var ctx = canvas.getContext('2d');

  function resizeCanvas() {
    canvas.width = canvas.parentElement.clientWidth;
    canvas.height = canvas.parentElement.clientHeight || 80;
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  var phase = 0;

  function draw() {
    requestAnimationFrame(draw);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    var amplitude = 0.08;
    var frequency = 0.02;
    var isPlaying = !elements.mainAudio.paused;

    if (isPlaying && analyserNode) {
      var bufferLength = analyserNode.frequencyBinCount;
      var dataArray = new Uint8Array(bufferLength);
      analyserNode.getByteFrequencyData(dataArray);
      var sum = 0;
      for (var i = 0; i < bufferLength; i++) sum += dataArray[i];
      var avg = sum / bufferLength;
      amplitude = 0.08 + (avg / 255) * 1.5;
      frequency = 0.015 + (avg / 255) * 0.025;
    }

    phase += isPlaying ? 0.08 : 0.02;

    var waveColors = [
      'rgba(91, 124, 250, 0.42)',
      'rgba(45, 185, 132, 0.32)',
      'rgba(201, 130, 56, 0.18)'
    ];

    for (var w = 0; w < 3; w++) {
      ctx.beginPath();
      ctx.lineWidth = w === 0 ? 2.5 : 1.5;
      ctx.strokeStyle = waveColors[w];
      var centerY = canvas.height / 2;
      var wavePhase = phase + (w * Math.PI / 3);
      var waveAmplitude = (canvas.height / 2.8) * amplitude * (1 - w * 0.2);
      for (var x = 0; x < canvas.width; x++) {
        var y = centerY + Math.sin(x * frequency + wavePhase) * waveAmplitude * Math.sin(Math.PI * x / canvas.width);
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }
  draw();
}



function setupAudioPlayer() {
  elements.mainAudio.addEventListener('durationchange', function () {
    updatePlaybackUI(0, elements.mainAudio.duration);
  });

  elements.mainAudio.addEventListener('timeupdate', function () {
    updatePlaybackUI(elements.mainAudio.currentTime, elements.mainAudio.duration || 0);
    highlightTranscriptPlayback(elements.mainAudio.currentTime);
  });

  elements.mainAudio.addEventListener('ended', function () {
    stopAudioPlayback();
  });

  elements.btnPlayPause.addEventListener('click', function () {
    if (elements.mainAudio.paused) startAudioPlayback();
    else pauseAudioPlayback();
  });

  elements.btnSkipBack.addEventListener('click', function () { seekAudioRelative(-15); });
  elements.btnSkipForward.addEventListener('click', function () { seekAudioRelative(15); });

  elements.progressBar.addEventListener('input', function (e) {
    var total = elements.mainAudio.duration || 0;
    elements.mainAudio.currentTime = (parseFloat(e.target.value) / 100) * total;
  });

  // Speed popup toggle
  elements.btnSpeed.addEventListener('click', function (e) {
    e.stopPropagation();
    elements.speedPopup.classList.toggle('hidden');
  });

  // Speed option selection
  elements.speedOptions.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var speed = parseFloat(btn.getAttribute('data-speed'));
      elements.mainAudio.playbackRate = speed;
      elements.speedLabel.textContent = speed === 1 ? '1x' : speed + 'x';
      elements.speedOptions.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      elements.speedPopup.classList.add('hidden');
    });
  });

  // Mute toggle
  elements.btnMute.addEventListener('click', function () {
    if (elements.mainAudio.volume > 0) {
      elements.mainAudio.volume = 0;
      updateMuteIcon(0);
    } else {
      elements.mainAudio.volume = 0.8;
      updateMuteIcon(0.8);
    }
  });

  // Close speed popup on outside click
  document.addEventListener('click', function () {
    elements.speedPopup.classList.add('hidden');
  });
}



function startAudioPlayback() {
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  var playPromise = elements.mainAudio.play();
  if (playPromise !== undefined) {
    playPromise.then(function () {
      setPlayerBadgeState('playing', '재생 중');
      elements.btnPlayPause.classList.add('playing');
      elements.btnPlayPause.innerHTML = '<i data-lucide="pause"></i>';
      elements.btnPlayPause.setAttribute('aria-label', '일시정지');
      if (window.lucide) window.lucide.createIcons();
    }).catch(function (err) {
      // Bluetooth 전환, autoplay 정책 등으로 play() 거부 — UI를 일시정지 상태로 복원
      console.warn('play() rejected:', err);
      setPlayerBadgeState('paused', '일시 정지');
      elements.btnPlayPause.classList.remove('playing');
      elements.btnPlayPause.innerHTML = '<i data-lucide="play"></i>';
      elements.btnPlayPause.setAttribute('aria-label', '재생');
      if (window.lucide) window.lucide.createIcons();
    });
  } else {
    setPlayerBadgeState('playing', '재생 중');
    elements.btnPlayPause.classList.add('playing');
    elements.btnPlayPause.innerHTML = '<i data-lucide="pause"></i>';
    elements.btnPlayPause.setAttribute('aria-label', '일시정지');
    if (window.lucide) window.lucide.createIcons();
  }
}



function pauseAudioPlayback() {
  elements.mainAudio.pause();
  setPlayerBadgeState('paused', '일시 정지');
  elements.btnPlayPause.classList.remove('playing');
  elements.btnPlayPause.innerHTML = '<i data-lucide="play"></i>';
  elements.btnPlayPause.setAttribute('aria-label', '재생');
  if (window.lucide) window.lucide.createIcons();
}



function stopAudioPlayback() {
  elements.mainAudio.pause();
  elements.mainAudio.currentTime = 0;
  setPlayerBadgeState('idle', '대기 중');
  elements.btnPlayPause.classList.remove('playing');
  elements.btnPlayPause.innerHTML = '<i data-lucide="play"></i>';
  elements.btnPlayPause.setAttribute('aria-label', '재생');
  if (window.lucide) window.lucide.createIcons();
}



function seekAudioRelative(seconds) {
  elements.mainAudio.currentTime = Math.max(0, Math.min(elements.mainAudio.duration || 0, elements.mainAudio.currentTime + seconds));
}



function updatePlaybackUI(elapsed, total) {
  elements.progressBar.value = total > 0 ? (elapsed / total) * 100 : 0;
  elements.timeElapsed.textContent = formatTime(elapsed);
  elements.timeTotal.textContent = formatTime(total);
}



function formatTime(secs) {
  if (isNaN(secs)) return '00:00';
  var m = Math.floor(secs / 60);
  var s = Math.floor(secs % 60);
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}



function updateMuteIcon(vol) {
  var iconName = vol === 0 ? 'volume-x' : vol < 0.4 ? 'volume-1' : 'volume-2';
  elements.btnMute.innerHTML = '<i data-lucide="' + iconName + '" id="mute-icon"></i>';
  elements.btnMute.setAttribute('aria-label', vol === 0 ? '음소거 해제' : '음소거');
  if (window.lucide) window.lucide.createIcons();
}



function setPlayerBadgeState(cls, text) {
  elements.statusBadge.className = 'status-badge ' + cls;
  elements.statusText.textContent = text;
}



function showTranscribeProgress(label, pct) {
  elements.transcribeProgress.classList.remove('hidden');
  elements.tpLabel.textContent = label;
  if (pct === null) {
    elements.tpFill.classList.add('indeterminate');
    elements.tpPct.textContent = '';
  } else {
    elements.tpFill.classList.remove('indeterminate');
    elements.tpFill.style.width = pct + '%';
    elements.tpPct.textContent = pct + '%';
  }
}



function hideTranscribeProgress() {
  elements.transcribeProgress.classList.add('hidden');
  elements.tpFill.style.width = '0%';
  elements.tpFill.classList.remove('indeterminate');
}



async function triggerTranscribeAI(options) {
  options = options || {};
  abortCurrentTranscription();
  var transcribeController = new AbortController();
  state.transcribeAbortController = transcribeController;
  var isBatchRun = state.fileQueue.length > 1;
  if (isBatchRun && !options.fromBatch) {
    state.batchRunning = true;
    state.batchIndex = Math.max(0, state.batchIndex || 0);
  }
  if (isBatchRun && state.fileQueue[state.batchIndex]) {
    state.fileQueue[state.batchIndex].status = 'running';
    renderBatchQueue();
  }

  stopAudioPlayback();
  elements.btnTranscribe.disabled = true;
  elements.btnCancelTranscribe.classList.remove('hidden');
  setPlayerBadgeState('transcribing', 'AI 분석 중');
  showTranscribeProgress('전사 중...', null);
  renderTranscriptLoadingState();

  try {
    if (!state.currentFile || !(state.currentFile instanceof File)) {
      throw new Error('오디오 파일 로드에 실패했습니다. 파일을 다시 선택해주세요.');
    }
    if (!state.apiKey) {
      throw new Error('OpenAI API Key를 입력해주세요.');
    }

    var whisperData = await transcribeAudioWithChunking(
      state.currentFile,
      state.language,
      state.apiKey,
      state.transcribeModel,
      transcribeController.signal,
      function (segments, chunkIndex, totalChunks) {
        state.transcriptParagraphs = parseWhisperSegments(segments);
        state.transcriptText = buildTranscriptText(state.transcriptParagraphs);
        renderTranscriptTimeline();
        enableTranscriptWorkspace();
        showTranscribeProgress('청크 ' + chunkIndex + ' / ' + totalChunks + ' 완료', Math.round((chunkIndex / totalChunks) * 100));
      }
    );
    state.transcriptParagraphs = parseWhisperSegments(whisperData.segments || []);
    state.transcriptText = buildTranscriptText(state.transcriptParagraphs);
    state.transcriptSourceName = state.currentFile.name;

    renderTranscriptTimeline();
    enableTranscriptWorkspace();
    saveTranscriptCache();

    renderSummaryReadyState();
    setPlayerBadgeState('idle', '대기 중');
    elements.btnTranscribe.disabled = false;
    elements.btnCancelTranscribe.classList.add('hidden');
    hideTranscribeProgress();
    if (state.transcribeAbortController === transcribeController) {
      state.transcribeAbortController = null;
    }
    markSummaryAttention(!elements.paneSummary.classList.contains('active'));
    showToast('전사 완료! AI 정리 탭에서 확인하세요.');

    if (isBatchRun && state.batchRunning) {
      state.fileQueue[state.batchIndex].status = 'done';
      state.batchResults.push({
        name: state.currentFile.name,
        text: state.transcriptText,
        paragraphs: state.transcriptParagraphs
      });
      renderBatchQueue();
      if (state.batchIndex < state.fileQueue.length - 1) {
        state.batchIndex += 1;
        handleAudioImport(state.fileQueue[state.batchIndex].file, { preserveQueue: true });
        await triggerTranscribeAI({ fromBatch: true });
        return;
      }
      state.batchRunning = false;
      elements.btnTranscribe.disabled = false;
      elements.btnCancelTranscribe.classList.add('hidden');
      renderBatchQueue();
      showToast('배치 전사가 완료되었습니다.');
    }
  } catch (err) {
    console.error('Transcription failed:', err);
    if (state.transcribeAbortController === transcribeController) {
      state.transcribeAbortController = null;
    }
    setPlayerBadgeState('idle', '대기 중');
    elements.btnTranscribe.disabled = false;
    elements.btnCancelTranscribe.classList.add('hidden');
    hideTranscribeProgress();
    if (err && err.name === 'AbortError') {
      if (isBatchRun && state.fileQueue[state.batchIndex]) {
        state.fileQueue[state.batchIndex].status = 'ready';
        state.batchRunning = false;
        renderBatchQueue();
      }
      resetWorkspaceData();
      showToast('전사를 취소했습니다.');
      return;
    }
    if (isBatchRun && state.fileQueue[state.batchIndex]) {
      state.fileQueue[state.batchIndex].status = 'failed';
      state.batchRunning = false;
      renderBatchQueue();
    }
    resetWorkspaceData();
    showToast('AI 전사 오류: ' + err.message);
  }
}


