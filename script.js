const STORAGE_KEY = 'lang-sns-data';
const DATA_VERSION = 1;
const STORAGE_LIMIT = 5 * 1024 * 1024; // 5MB approximate
const IMAGE_RESIZE_THRESHOLD = 1024 * 1024; // 1MB

const defaultData = () => ({
  version: DATA_VERSION,
  posts: [],
  replies: [],
  images: {},
  lastId: 0,
});

const state = {
  data: defaultData(),
  currentTab: 'timeline',
  imageCache: new Map(),
};

const langOptions = [
  { value: 'ja', label: 'JA (日本語)', speakable: false },
  { value: 'en-US', label: 'EN (英語)', voiceHint: 'Samantha', speakable: true },
  { value: 'ko-KR', label: 'KO (韓国語)', voiceHint: 'Yuna', speakable: true },
  { value: 'zh-TW', label: 'zh-TW (台湾華語)', voiceHint: 'Meijia', speakable: true },
];

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed.version !== DATA_VERSION) {
      state.data = { ...defaultData(), ...parsed, version: DATA_VERSION };
    } else {
      state.data = parsed;
    }
  } catch (e) {
    console.error('Failed to load data', e);
    state.data = defaultData();
  }
}

function persistData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
  enforceStorageLimit();
}

function nextId() {
  state.data.lastId += 1;
  return state.data.lastId;
}

function extractTags(texts) {
  const tagSet = new Set();
  const regex = /#([\p{L}\p{N}_-]+)/gu;
  texts.forEach((t) => {
    let m;
    while ((m = regex.exec(t.content))) {
      tagSet.add(m[1]);
    }
  });
  return Array.from(tagSet);
}

function formatDate(ts) {
  const d = new Date(ts);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function resizeIfNeeded(dataUrl) {
  if (dataUrl.length <= IMAGE_RESIZE_THRESHOLD) return dataUrl;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const maxWidth = 900;
      const scale = Math.min(1, maxWidth / img.width);
      const canvas = document.createElement('canvas');
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.9));
    };
    img.src = dataUrl;
  });
}

function ensureImageId(dataUrl) {
  // deduplicate identical images
  for (const [id, stored] of Object.entries(state.data.images)) {
    if (stored === dataUrl) return id;
  }
  const id = `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  state.data.images[id] = dataUrl;
  return id;
}

function removeImageIfUnused(imageId) {
  if (!imageId) return;
  const used = state.data.posts.some((p) => p.imageId === imageId) ||
    state.data.replies.some((r) => r.imageId === imageId);
  if (!used) {
    delete state.data.images[imageId];
  }
}

function enforceStorageLimit() {
  let serialized = JSON.stringify(state.data);
  while (serialized.length > STORAGE_LIMIT) {
    // remove images from oldest posts first
    const candidates = [...state.data.posts]
      .filter((p) => p.imageId)
      .sort((a, b) => a.createdAt - b.createdAt);
    if (!candidates.length) break;
    const target = candidates[0];
    removeImageIfUnused(target.imageId);
    target.imageId = null;
    target.imageRemoved = true;
    serialized = JSON.stringify(state.data);
  }
  localStorage.setItem(STORAGE_KEY, serialized);
}

function openModal(content, title = '投稿') {
  const modal = document.getElementById('modal');
  const body = document.getElementById('modal-body');
  const titleEl = document.getElementById('modal-title');
  titleEl.textContent = title;
  body.innerHTML = '';
  body.appendChild(content);
  modal.classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal').classList.add('hidden');
}

function createTextBlockInput(value = '', lang = 'ja', removable = true, onRemove = null) {
  const wrapper = document.createElement('div');
  wrapper.className = 'text-area-wrapper';

  const textarea = document.createElement('textarea');
  textarea.value = value;
  wrapper.appendChild(textarea);

  const langRow = document.createElement('div');
  langRow.className = 'language-select';

  const select = document.createElement('select');
  langOptions.forEach((opt) => {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    if (opt.value === lang) option.selected = true;
    select.appendChild(option);
  });
  langRow.appendChild(select);

  const speakBtn = document.createElement('button');
  speakBtn.type = 'button';
  speakBtn.textContent = '▶︎ 再生';
  speakBtn.addEventListener('click', () => playSpeech(textarea.value, select.value));
  langRow.appendChild(speakBtn);

  if (removable) {
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      if (wrapper.parentElement.children.length > 1) {
        wrapper.remove();
        if (onRemove) onRemove();
      }
    });
    removeBtn.className = 'remove-text-btn';
    langRow.appendChild(removeBtn);
  }

  wrapper.appendChild(langRow);
  return wrapper;
}

function buildPostForm({ mode = 'create', targetPost = null, parentId = null }) {
  const container = document.createElement('div');
  const textAreaContainer = document.createElement('div');
  textAreaContainer.id = 'text-block-container';
  let addBtn;

  const updateTextControls = () => {
    const count = textAreaContainer.children.length;
    if (addBtn) addBtn.disabled = count >= 3;
    const removeButtons = textAreaContainer.querySelectorAll('.remove-text-btn');
    removeButtons.forEach((btn) => {
      btn.disabled = count <= 1;
    });
  };

  const handleTextBlockChange = () => updateTextControls();

  const addTextBlock = (content = '', language = 'ja') => {
    const block = createTextBlockInput(content, language, true, handleTextBlockChange);
    textAreaContainer.appendChild(block);
    handleTextBlockChange();
  };

  if (targetPost) {
    textAreaContainer.innerHTML = '';
    const texts = targetPost.texts || [{ content: '', language: 'ja' }];
    texts.forEach((t) => addTextBlock(t.content, t.language));
  } else {
    addTextBlock();
  }

  addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.textContent = '＋ テキスト追加';
  addBtn.addEventListener('click', () => {
    if (textAreaContainer.children.length >= 3) return;
    addTextBlock();
  });

  updateTextControls();

  const imageRow = document.createElement('div');
  imageRow.className = 'form-row';
  const fileLabel = document.createElement('label');
  fileLabel.className = 'file-button';
  fileLabel.textContent = '画像を選択（1枚まで）';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileLabel.appendChild(fileInput);
  imageRow.appendChild(fileLabel);

  const imagePreview = document.createElement('div');
  imagePreview.className = 'image-preview';
  imageRow.appendChild(imagePreview);

  const removeImageBtn = document.createElement('button');
  removeImageBtn.type = 'button';
  removeImageBtn.textContent = '画像を削除';
  removeImageBtn.className = 'danger';
  imageRow.appendChild(removeImageBtn);

  const originalImageId = targetPost?.imageId || null;
  const existingImageUrl = originalImageId ? state.data.images[originalImageId] : null;
  let imageDataUrl = null;
  let removeImage = false;

  const renderPreview = () => {
    imagePreview.innerHTML = '';
    const currentUrl = imageDataUrl || (!removeImage ? existingImageUrl : null);
    if (currentUrl) {
      const img = document.createElement('img');
      img.src = currentUrl;
      img.alt = '選択中の画像';
      imagePreview.appendChild(img);
    } else {
      const helper = document.createElement('div');
      helper.className = 'helper';
      helper.textContent = '画像は選択されていません。';
      imagePreview.appendChild(helper);
    }
    removeImageBtn.disabled = !currentUrl && !existingImageUrl;
  };

  renderPreview();

  fileInput.addEventListener('change', async (e) => {
    const [file] = e.target.files;
    if (!file) return;
    const dataUrl = await readFileAsDataUrl(file);
    imageDataUrl = await resizeIfNeeded(dataUrl);
    removeImage = false;
    renderPreview();
  });

  removeImageBtn.addEventListener('click', () => {
    imageDataUrl = null;
    removeImage = true;
    fileInput.value = '';
    renderPreview();
  });

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'キャンセル';
  cancelBtn.addEventListener('click', () => closeModal());
  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'primary';
  submitBtn.textContent = mode === 'reply' ? '返信' : mode === 'edit' ? '保存' : '投稿';

  submitBtn.addEventListener('click', async () => {
    const textBlocks = Array.from(textAreaContainer.children).map((el) => ({
      content: el.querySelector('textarea').value.trim(),
      language: el.querySelector('select').value,
    }));
    const hasContent = textBlocks.some((t) => t.content.length > 0);
    if (!hasContent) {
      alert('テキストを入力してください。');
      return;
    }
    const tags = extractTags(textBlocks);
    let imageId = targetPost ? targetPost.imageId : null;

    if (imageDataUrl) {
      imageId = ensureImageId(imageDataUrl);
    } else if (removeImage) {
      imageId = null;
    }

    if (mode === 'reply') {
      const reply = {
        id: nextId(),
        postId: parentId,
        texts: textBlocks,
        tags,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        imageId: imageId || null,
        isDeleted: false,
      };
      state.data.replies.push(reply);
    } else if (mode === 'edit' && targetPost) {
      targetPost.texts = textBlocks;
      targetPost.tags = tags;
      targetPost.updatedAt = Date.now();
      if (imageDataUrl !== null) {
        targetPost.imageId = imageId;
        targetPost.imageRemoved = false;
        if (originalImageId && originalImageId !== imageId) {
          removeImageIfUnused(originalImageId);
        }
      } else if (removeImage) {
        removeImageIfUnused(originalImageId);
        targetPost.imageId = null;
        targetPost.imageRemoved = false;
      }
    } else {
      const post = {
        id: nextId(),
        texts: textBlocks,
        tags,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        imageId: imageId || null,
        imageRemoved: false,
        isDeleted: false,
        liked: false,
        likedAt: null,
        repostOf: targetPost?.id ?? null,
      };
      state.data.posts.push(post);
    }

    persistData();
    closeModal();
    render();
  });

  actions.append(cancelBtn, submitBtn);

  container.appendChild(textAreaContainer);
  container.appendChild(addBtn);
  container.appendChild(imageRow);
  container.appendChild(actions);
  return container;
}

function playSpeech(text, lang) {
  if (!text || lang === 'ja') return;
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = lang;
  const voices = window.speechSynthesis.getVoices();
  const hint = langOptions.find((l) => l.value === lang)?.voiceHint;
  if (hint) {
    const voice = voices.find((v) => v.name.includes(hint));
    if (voice) utter.voice = voice;
  }
  window.speechSynthesis.speak(utter);
}

function render() {
  renderTimeline();
  renderImages();
  renderLikes();
  runSearch();
}

function renderTimeline() {
  const container = document.getElementById('timeline-list');
  container.innerHTML = '';
  const sorted = [...state.data.posts].sort((a, b) => b.createdAt - a.createdAt);
  if (!sorted.length) {
    container.innerHTML = '<div class="empty-state">投稿がありません。新規投稿してみましょう。</div>';
    return;
  }
  sorted.forEach((post) => {
    const node = renderPostCard(post);
    container.appendChild(node);
  });
}

function renderImages() {
  const container = document.getElementById('images-list');
  container.innerHTML = '';
  const posts = state.data.posts.filter((p) => p.imageId && state.data.images[p.imageId]);
  if (!posts.length) {
    container.innerHTML = '<div class="empty-state">画像付きポストはありません。</div>';
    return;
  }
  posts.sort((a, b) => b.createdAt - a.createdAt);
  posts.forEach((post) => {
    const node = renderPostCard(post, { highlightImage: true });
    container.appendChild(node);
  });
}

function renderLikes() {
  const container = document.getElementById('likes-list');
  container.innerHTML = '';
  const liked = state.data.posts.filter((p) => p.liked).sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0));
  if (!liked.length) {
    container.innerHTML = '<div class="empty-state">いいねしたポストはありません。</div>';
    return;
  }
  liked.forEach((post) => container.appendChild(renderPostCard(post)));
}

function renderPostCard(post, options = {}) {
  const template = document.getElementById('post-template');
  const node = template.content.firstElementChild.cloneNode(true);
  const meta = node.querySelector('.card-meta');
  const body = node.querySelector('.card-body');
  const tagsEl = node.querySelector('.tag-list');
  const actions = node.querySelector('.card-actions');
  const repliesWrap = node.querySelector('.replies');

    meta.textContent = `${formatDate(post.createdAt)}${post.updatedAt && post.updatedAt !== post.createdAt ? '（編集済み）' : ''}${post.repostOf ? ' / 🔁 Repost' : ''}`;

  body.innerHTML = '';
  if (post.isDeleted) {
    body.innerHTML = '<div class="text-block">このポストは削除されました</div>';
  } else {
    post.texts.forEach((t) => {
      const block = document.createElement('div');
      block.className = 'text-block';
      const label = document.createElement('div');
      label.className = 'text-label';
      label.textContent = t.language.toUpperCase();
      const play = document.createElement('button');
      play.type = 'button';
      play.textContent = '▶︎';
      play.disabled = t.language === 'ja';
      play.addEventListener('click', () => playSpeech(t.content, t.language));
      label.appendChild(play);
      const content = document.createElement('div');
      content.className = 'text-content';
      content.textContent = t.content;
      block.append(label, content);
      body.appendChild(block);
    });

    if (post.imageRemoved) {
      const removed = document.createElement('div');
      removed.className = 'helper';
      removed.textContent = '画像は容量制限のため削除されました';
      body.appendChild(removed);
    } else if (post.imageId && state.data.images[post.imageId]) {
      const img = document.createElement('img');
      img.src = state.data.images[post.imageId];
      img.alt = '投稿画像';
      img.className = options.highlightImage ? 'image-thumb highlight' : 'image-thumb';
      img.addEventListener('click', () => openImageViewer(img.src));
      body.appendChild(img);
    }
  }

  tagsEl.innerHTML = '';
  post.tags.forEach((tag) => {
    const chip = document.createElement('span');
    chip.className = 'tag';
    chip.textContent = `#${tag}`;
    chip.addEventListener('click', () => {
      document.querySelector('.tabs button[data-tab="search"]').click();
      document.getElementById('search-input').value = `#${tag}`;
      runSearch();
    });
    tagsEl.appendChild(chip);
  });

  actions.innerHTML = '';
  if (!post.isDeleted) {
    const delBtn = document.createElement('button');
    delBtn.className = 'danger';
    delBtn.textContent = '削除';
    delBtn.addEventListener('click', () => deletePost(post.id));

    const editBtn = document.createElement('button');
    editBtn.textContent = '編集';
    editBtn.addEventListener('click', () => openModal(buildPostForm({ mode: 'edit', targetPost: post }), '投稿を編集'));

    const repostBtn = document.createElement('button');
    repostBtn.className = 'repost';
    repostBtn.textContent = 'リポスト';
    repostBtn.addEventListener('click', () => {
      const duplicate = { ...post, repostOf: post.id };
      openModal(buildPostForm({ mode: 'create', targetPost: duplicate }), 'リポスト');
    });

    const replyBtn = document.createElement('button');
    replyBtn.textContent = '返信';
    replyBtn.addEventListener('click', () => openModal(buildPostForm({ mode: 'reply', parentId: post.id }), '返信'));

    const likeBtn = document.createElement('button');
    likeBtn.textContent = post.liked ? 'いいね中' : 'いいね';
    if (post.liked) likeBtn.classList.add('liked');
    likeBtn.addEventListener('click', () => toggleLike(post.id));

    actions.append(delBtn, editBtn, repostBtn, replyBtn, likeBtn);
  }

  const rels = state.data.replies
    .filter((r) => r.postId === post.id)
    .sort((a, b) => a.createdAt - b.createdAt);
  repliesWrap.innerHTML = '';
  rels.forEach((reply) => {
    const card = document.createElement('div');
    card.className = 'reply-card';
    const metaRow = document.createElement('div');
    metaRow.className = 'card-meta';
    metaRow.textContent = formatDate(reply.createdAt);
    const bodyRow = document.createElement('div');
    bodyRow.className = 'card-body';
    reply.texts.forEach((t) => {
      const block = document.createElement('div');
      block.className = 'text-block';
      const label = document.createElement('div');
      label.className = 'text-label';
      label.textContent = t.language.toUpperCase();
      const play = document.createElement('button');
      play.type = 'button';
      play.textContent = '▶︎';
      play.disabled = t.language === 'ja';
      play.addEventListener('click', () => playSpeech(t.content, t.language));
      label.appendChild(play);
      const content = document.createElement('div');
      content.className = 'text-content';
      content.textContent = t.content;
      block.append(label, content);
      bodyRow.appendChild(block);
    });
    if (reply.imageId && state.data.images[reply.imageId]) {
      const img = document.createElement('img');
      img.src = state.data.images[reply.imageId];
      img.className = 'image-thumb';
      img.alt = 'リプライ画像';
      img.addEventListener('click', () => openImageViewer(img.src));
      bodyRow.appendChild(img);
    }

    const actionsRow = document.createElement('div');
    actionsRow.className = 'card-actions';
    const delReply = document.createElement('button');
    delReply.className = 'danger';
    delReply.textContent = '削除';
    delReply.addEventListener('click', () => deleteReply(reply.id));
    const editReply = document.createElement('button');
    editReply.textContent = '編集';
    editReply.addEventListener('click', () => openModal(buildPostForm({ mode: 'edit', targetPost: reply }), 'リプライを編集'));
    actionsRow.append(delReply, editReply);

    card.append(metaRow, bodyRow, actionsRow);
    repliesWrap.appendChild(card);
  });

  return node;
}

function openImageViewer(src) {
  const viewer = document.getElementById('image-viewer');
  const img = document.getElementById('full-image');
  img.src = src;
  viewer.classList.remove('hidden');
}

function deletePost(id) {
  const post = state.data.posts.find((p) => p.id === id);
  if (!post) return;
  const confirmed = window.confirm('このポストを削除しますか？');
  if (!confirmed) return;
  const hasReplies = state.data.replies.some((r) => r.postId === id);
  if (hasReplies) {
    post.isDeleted = true;
    post.texts = [{ content: '', language: 'ja' }];
  } else {
    removeImageIfUnused(post.imageId);
    state.data.posts = state.data.posts.filter((p) => p.id !== id);
  }
  persistData();
  render();
}

function deleteReply(id) {
  const target = state.data.replies.find((r) => r.id === id);
  if (!target) return;
  const confirmed = window.confirm('このリプライを削除しますか？');
  if (!confirmed) return;
  removeImageIfUnused(target.imageId);
  state.data.replies = state.data.replies.filter((r) => r.id !== id);
  persistData();
  render();
}

function toggleLike(id) {
  const post = state.data.posts.find((p) => p.id === id);
  if (!post || post.isDeleted) return;
  post.liked = !post.liked;
  post.likedAt = post.liked ? Date.now() : null;
  persistData();
  render();
}

function runSearch() {
  const query = document.getElementById('search-input').value.trim();
  const container = document.getElementById('search-results');
  container.innerHTML = '';
  const terms = query.split(/\s+/).filter(Boolean);
  let tagFilter = null;
  const textTerms = [];
  terms.forEach((t) => {
    if (t.startsWith('#')) tagFilter = t.slice(1);
    else textTerms.push(t);
  });

  let results = state.data.posts.filter((p) => !p.isDeleted);
  if (tagFilter) {
    const tagLower = tagFilter.toLowerCase();
    results = results.filter((p) => p.tags.some((tag) => tag.toLowerCase() === tagLower));
  }
  if (textTerms.length) {
    const lowerTerms = textTerms.map((t) => t.toLowerCase());
    results = results.filter((p) => lowerTerms.every((term) => p.texts.some((t) => t.content.toLowerCase().includes(term))));
  }
  results.sort((a, b) => b.createdAt - a.createdAt);

  if (!results.length) {
    container.innerHTML = '<div class="empty-state">検索結果がありません。</div>';
    return;
  }
  results.forEach((p) => container.appendChild(renderPostCard(p)));
}

function exportData() {
  const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'lang-sns-backup.json';
  a.click();
  URL.revokeObjectURL(url);
}

function importData(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const json = JSON.parse(reader.result);
      state.data = { ...defaultData(), ...json, version: DATA_VERSION };
      persistData();
      render();
    } catch (e) {
      alert('JSONの読み込みに失敗しました');
    }
  };
  reader.readAsText(file);
}

function setupTabs() {
  document.querySelectorAll('.tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.currentTab = btn.dataset.tab;
      document.querySelectorAll('.tab-panel').forEach((panel) => {
        panel.classList.toggle('active', panel.id === state.currentTab);
      });
    });
  });
}

function setupGlobalEvents() {
  ['new-post-btn', 'fab-new-post'].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', () => openModal(buildPostForm({ mode: 'create' }), '新規投稿'));
  });
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('image-close').addEventListener('click', () => document.getElementById('image-viewer').classList.add('hidden'));
  document.getElementById('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  document.getElementById('image-viewer').addEventListener('click', (e) => { if (e.target.id === 'image-viewer') e.target.classList.add('hidden'); });
  document.getElementById('export-btn').addEventListener('click', exportData);
  document.getElementById('import-input').addEventListener('change', (e) => importData(e.target.files[0]));
  document.getElementById('search-btn').addEventListener('click', runSearch);
  document.getElementById('search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
  window.addEventListener('beforeunload', () => window.speechSynthesis.cancel());
}

function init() {
  loadData();
  setupTabs();
  setupGlobalEvents();
  render();
}

document.addEventListener('DOMContentLoaded', init);
