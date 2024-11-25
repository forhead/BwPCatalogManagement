export const generateId = () => {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
};

export const validateProduct = (product) => {
  // TODO: Implement product validation
  return true;
};

export const handleError = (error) => {
  console.error('Error:', error);
  return {
    statusCode: 500,
    body: JSON.stringify({ message: 'Internal server error' })
  };
};
