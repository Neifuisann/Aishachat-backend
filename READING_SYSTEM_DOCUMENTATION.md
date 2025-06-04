# Reading System Documentation

## Overview
The Reading System is a comprehensive book reading and management solution integrated into the AI assistant. It provides functionality for reading books, tracking progress, searching within books, and managing reading preferences.

## Features

### 📚 Book Reading
- Read books from public and private libraries
- Support for different reading modes (paragraphs, sentences, full page)
- Page-by-page navigation
- Continue reading from last position

### 📊 Reading History
- Track reading progress per book per user
- Remember last read page and position
- Automatic progress updates

### 🔍 Search Functionality
- Search for keywords within books
- Context-aware search results
- Page-specific search results

### ⚙️ Reading Settings
- Customizable reading modes
- Adjustable reading amounts
- User-specific preferences

## Architecture

### File Structure
```
books/
├── public/          # Public library (accessible to all users)
│   └── sample_story.txt
└── private/         # Private libraries (user-specific)
    └── {user_id}/   # User-specific book collections
```

### Database Schema

#### reading_history
- `history_id` (UUID, Primary Key)
- `user_id` (UUID, Foreign Key to users)
- `book_name` (TEXT)
- `current_page` (INTEGER)
- `total_pages` (INTEGER)
- `last_read_at` (TIMESTAMPTZ)
- `created_at` (TIMESTAMPTZ)

#### reading_settings
- `settings_id` (UUID, Primary Key)
- `user_id` (UUID, Foreign Key to users)
- `reading_mode` (TEXT: 'paragraphs', 'sentences', 'fullpage')
- `reading_amount` (INTEGER)
- `created_at` (TIMESTAMPTZ)
- `updated_at` (TIMESTAMPTZ)

#### books
- `book_id` (UUID, Primary Key)
- `book_name` (TEXT, Unique)
- `file_path` (TEXT)
- `total_pages` (INTEGER)
- `is_public` (BOOLEAN)
- `author` (TEXT, Optional)
- `description` (TEXT, Optional)
- `created_at` (TIMESTAMPTZ)

## Function Interface

### ReadingManager Function
The system uses a unified modal interface similar to the existing ManageData function.

#### Parameters
- `mode`: "History" | "Read" | "Search" | "Settings"
- `action`: Varies by mode
- `bookName`: Book name (required for History, Read, Search)
- `pageNumber`: Page number (for Read GoTo action)
- `keyword`: Search keyword (for Search Find action)
- `readingMode`: Reading mode (for Settings Set action)
- `readingAmount`: Reading amount (for Settings Set action)

#### Mode-Action Combinations

**History Mode:**
- `Check`: Get reading progress for a book

**Read Mode:**
- `Continue`: Continue from last read position
- `Start`: Start reading from the beginning
- `GoTo`: Go to a specific page

**Search Mode:**
- `Find`: Search for keywords in a book

**Settings Mode:**
- `Get`: Get current reading preferences
- `Set`: Update reading preferences

## Usage Examples

### 1. Check Reading History
```javascript
ReadingManager(supabase, userId, "History", "Check", "sample_story")
```

### 2. Start Reading a Book
```javascript
ReadingManager(supabase, userId, "Read", "Start", "sample_story")
```

### 3. Continue Reading
```javascript
ReadingManager(supabase, userId, "Read", "Continue", "sample_story")
```

### 4. Go to Specific Page
```javascript
ReadingManager(supabase, userId, "Read", "GoTo", "sample_story", 5)
```

### 5. Search in Book
```javascript
ReadingManager(supabase, userId, "Search", "Find", "sample_story", null, "treasure")
```

### 6. Get Reading Settings
```javascript
ReadingManager(supabase, userId, "Settings", "Get")
```

### 7. Set Reading Preferences
```javascript
ReadingManager(supabase, userId, "Settings", "Set", null, null, null, "paragraphs", 3)
```

## Reading Modes

### Full Page Mode
- Reads the entire page content
- Best for immersive reading experience

### Paragraph Mode
- Reads a specified number of paragraphs
- Good for controlled reading sessions
- Configurable amount (1-10 paragraphs)

### Sentence Mode
- Reads a specified number of sentences
- Best for detailed, slow reading
- Configurable amount (1-20 sentences)

## User Flow Examples

### First Time Reading
1. User asks: "I want to read a book called 'sample_story'"
2. AI calls: `ReadingManager(supabase, userId, "History", "Check", "sample_story")`
3. System returns: No reading history found
4. AI asks: "This book hasn't been read yet. Would you like to start from the beginning?"
5. User confirms
6. AI calls: `ReadingManager(supabase, userId, "Read", "Start", "sample_story")`
7. System returns book content and updates reading progress

### Continuing Reading
1. User asks: "Continue reading sample_story"
2. AI calls: `ReadingManager(supabase, userId, "History", "Check", "sample_story")`
3. System returns: Currently on page 3 of 6
4. AI asks: "You're currently on page 3. Would you like to continue?"
5. User confirms
6. AI calls: `ReadingManager(supabase, userId, "Read", "Continue", "sample_story")`
7. System returns content from page 3

### Searching in Books
1. User asks: "Find mentions of 'treasure' in sample_story"
2. AI calls: `ReadingManager(supabase, userId, "Search", "Find", "sample_story", null, "treasure")`
3. System returns search results with page numbers and context
4. AI presents results to user

## Integration with AI Assistant

### Tool Calling Instructions
The ReadingManager is integrated into the AI assistant's tool calling system with specific instructions:

```
READINGMANAGER MODAL INTERFACE:
1. First select mode: "History", "Read", "Search", or "Settings"
2. Then select appropriate action for each mode
3. Provide required parameters based on mode/action combination

READING MODES:
- History: "Check" (get reading progress for a book, provide bookName)
- Read: "Continue" (from last position), "Start" (from beginning), "GoTo" (specific page, provide pageNumber)
- Search: "Find" (search keywords in book, provide bookName and keyword)
- Settings: "Get" (current reading preferences), "Set" (update preferences, provide readingMode and readingAmount)
```

## Error Handling

The system includes comprehensive error handling for:
- Invalid book names
- Missing files
- Invalid page numbers
- Database connection issues
- Invalid parameters

## Testing

The system includes a test suite (`test_reading_system.ts`) that validates:
- File reading operations
- Page splitting functionality
- Search capabilities
- Reading mode implementations

## Future Enhancements

### Planned Features
1. **Bookmarks**: Save specific positions within books
2. **Reading Statistics**: Track reading time and speed
3. **Book Recommendations**: Suggest books based on reading history
4. **Audio Reading**: Text-to-speech integration
5. **Private Library Management**: Upload and manage personal books
6. **Reading Groups**: Share reading progress with others
7. **Annotations**: Add notes and highlights to books

### Technical Improvements
1. **Caching**: Cache frequently accessed books
2. **Pagination**: Better page splitting algorithms
3. **Search Optimization**: Full-text search with ranking
4. **Backup**: Reading progress backup and sync
5. **Analytics**: Reading behavior analytics

## Maintenance

### Adding New Books
1. Place book file in `books/public/` or `books/private/{user_id}/`
2. Add entry to `books` table with metadata
3. Ensure proper file permissions

### Database Maintenance
- Regular cleanup of old reading history
- Index optimization for search performance
- Backup reading data regularly

## Security Considerations

- User isolation: Private books are user-specific
- Input validation: All parameters are validated
- SQL injection prevention: Parameterized queries
- File access control: Restricted to books directory

## Performance

- Efficient file reading with streaming for large books
- Database indexing on frequently queried fields
- Lazy loading of book content
- Optimized search algorithms

This reading system provides a robust foundation for book reading functionality in the AI assistant, with room for future enhancements and scalability.
