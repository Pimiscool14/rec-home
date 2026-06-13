// Middleware to check if user is authenticated
function isAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  
  // If API request, return JSON
  if (req.path.startsWith('/api/') || req.headers['content-type'] === 'application/json') {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  // For web requests, redirect to login
  req.flash('error', 'Please log in to access this page.');
  res.redirect('/login');
}

// Middleware to check if user has specific role
function hasRole(...roles) {
  return (req, res, next) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    
    next();
  };
}

// Middleware to set user data in all views
function setUserLocals(req, res, next) {
  res.locals.user = req.user || null;
  res.locals.messages = {
    error: req.flash('error'),
    success: req.flash('success'),
    info: req.flash('info'),
  };
  next();
}

module.exports = { isAuthenticated, hasRole, setUserLocals };
