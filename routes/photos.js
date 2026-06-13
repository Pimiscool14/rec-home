const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const db = require('../database/db');
const { isAuthenticated } = require('../middleware/auth');

const router = express.Router();

// Multer storage config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '..', 'uploads', 'photos');
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${uniqueName}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, GIF, and WebP images are allowed.'));
    }
  },
});

// ==================== Upload Photo (Web) ====================
router.post('/upload', isAuthenticated, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      req.flash('error', 'Please select a photo to upload.');
      return res.redirect('/gallery');
    }

    const { title, description, room_name, is_public } = req.body;

    // Get image dimensions
    let width = 0, height = 0;
    try {
      const metadata = await sharp(req.file.path).metadata();
      width = metadata.width || 0;
      height = metadata.height || 0;
    } catch (e) {
      // If sharp fails, just store without dimensions
    }

    // Create thumbnail
    const thumbFilename = `thumb_${req.file.filename}`;
    const thumbPath = path.join(__dirname, '..', 'uploads', 'thumbnails', thumbFilename);
    try {
      await sharp(req.file.path)
        .resize(400, 300, { fit: 'cover' })
        .jpeg({ quality: 80 })
        .toFile(thumbPath);
    } catch (e) {
      // Thumbnail creation failed, non-critical
    }

    db.prepare(`
      INSERT INTO photos (user_id, filename, original_name, title, description, room_name, width, height, file_size, is_public)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.user.id, req.file.filename, req.file.originalname,
      title || 'Untitled', description || '', room_name || '',
      width, height, req.file.size,
      is_public === 'on' ? 1 : 0
    );

    req.flash('success', 'Photo uploaded and saved to your gallery!');
    res.redirect('/gallery');
  } catch (err) {
    console.error('Photo upload error:', err);
    req.flash('error', 'Failed to upload photo. Please try again.');
    res.redirect('/gallery');
  }
});

// ==================== Upload Photo (API) ====================
router.post('/upload-api', (req, res) => {
  const apiUpload = upload.single('photo');
  apiUpload(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }

    // API key auth or session auth
    let userId = null;
    if (req.isAuthenticated()) {
      userId = req.user.id;
    } else {
      const apiKey = req.headers['x-api-key'] || req.query.api_key;
      if (apiKey) {
        const keyRecord = db.prepare('SELECT user_id FROM api_keys WHERE api_key = ?').get(apiKey);
        if (keyRecord) userId = keyRecord.user_id;
      }
    }

    if (!userId) {
      // Clean up uploaded file
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(401).json({ error: 'Authentication required.' });
    }

    try {
      let width = 0, height = 0;
      try {
        const metadata = await sharp(req.file.path).metadata();
        width = metadata.width || 0;
        height = metadata.height || 0;
      } catch (e) {}

      const thumbFilename = `thumb_${req.file.filename}`;
      const thumbPath = path.join(__dirname, '..', 'uploads', 'thumbnails', thumbFilename);
      try {
        await sharp(req.file.path)
          .resize(400, 300, { fit: 'cover' })
          .jpeg({ quality: 80 })
          .toFile(thumbPath);
      } catch (e) {}

      const result = db.prepare(`
        INSERT INTO photos (user_id, filename, original_name, title, room_name, width, height, file_size)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId, req.file.filename, req.file.originalname,
        req.body.title || 'Untitled', req.body.room || '',
        width, height, req.file.size
      );

      res.json({
        success: true,
        photo: {
          id: result.lastInsertRowid,
          url: `/uploads/photos/${req.file.filename}`,
          thumbnail: `/uploads/thumbnails/${thumbFilename}`,
        },
      });
    } catch (e) {
      res.status(500).json({ error: 'Upload failed.' });
    }
  });
});

// ==================== Get User Photos ====================
router.get('/my', isAuthenticated, (req, res) => {
  const photos = db.prepare(
    'SELECT * FROM photos WHERE user_id = ? ORDER BY created_at DESC'
  ).all(req.user.id);
  res.json(photos);
});

// ==================== Get Public Photos Feed ====================
router.get('/feed', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;

  const photos = db.prepare(`
    SELECT p.*, u.username, u.display_name, u.avatar_url
    FROM photos p
    JOIN users u ON p.user_id = u.id
    WHERE p.is_public = 1
    ORDER BY p.created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  const total = db.prepare('SELECT COUNT(*) as count FROM photos WHERE is_public = 1').get().count;

  res.json({
    photos,
    page,
    totalPages: Math.ceil(total / limit),
    total,
  });
});

// ==================== Like Photo ====================
router.post('/:id/like', isAuthenticated, (req, res) => {
  const photoId = req.params.id;

  const existing = db.prepare('SELECT id FROM photo_likes WHERE photo_id = ? AND user_id = ?').get(photoId, req.user.id);

  if (existing) {
    db.prepare('DELETE FROM photo_likes WHERE id = ?').run(existing.id);
    db.prepare('UPDATE photos SET likes_count = MAX(0, likes_count - 1) WHERE id = ?').run(photoId);
    res.json({ liked: false });
  } else {
    db.prepare('INSERT INTO photo_likes (photo_id, user_id) VALUES (?, ?)').run(photoId, req.user.id);
    db.prepare('UPDATE photos SET likes_count = likes_count + 1 WHERE id = ?').run(photoId);
    res.json({ liked: true });
  }
});

// ==================== Delete Photo ====================
router.delete('/:id', isAuthenticated, (req, res) => {
  const photo = db.prepare('SELECT * FROM photos WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!photo) {
    return res.status(404).json({ error: 'Photo not found or not yours.' });
  }

  // Delete files
  const photoPath = path.join(__dirname, '..', 'uploads', 'photos', photo.filename);
  const thumbPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumb_${photo.filename}`);
  try { fs.unlinkSync(photoPath); } catch (e) {}
  try { fs.unlinkSync(thumbPath); } catch (e) {}

  db.prepare('DELETE FROM photos WHERE id = ?').run(req.params.id);

  if (req.headers['content-type']?.includes('application/json')) {
    res.json({ success: true });
  } else {
    req.flash('success', 'Photo deleted.');
    res.redirect('/gallery');
  }
});

module.exports = router;
