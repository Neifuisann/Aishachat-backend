# PDF Processing for Vietnamese Books

This directory contains tools to extract text from Vietnamese PDF books and convert them into a format compatible with the reading system.

## Setup

### 1. Install Python Dependencies
```bash
pip install -r requirements.txt
```

### 2. Directory Structure
```
pdf_processing/
├── input/          # Place your PDF files here
├── output/         # Extracted text files will be saved here
├── extract_pdf.py  # Main extraction script
├── requirements.txt
└── README.md
```

## Usage

### Processing Single PDF File
```bash
python extract_pdf.py --file "path/to/your/book.pdf"
```

### Processing All PDFs in Input Directory
```bash
# Place PDF files in the input/ directory, then run:
python extract_pdf.py

# Or specify custom directories:
python extract_pdf.py --input "custom_input_dir" --output "custom_output_dir"
```

### Command Line Options
- `--input, -i`: Input directory containing PDF files (default: input)
- `--output, -o`: Output directory for extracted text files (default: output)
- `--file, -f`: Process a single PDF file

## Features

### 📚 Vietnamese Text Support
- Full UTF-8 encoding support
- Proper handling of Vietnamese diacritics
- Text cleaning and normalization

### 🏷️ Navigation Markers
The extracted text includes navigation markers for enhanced reading experience:

#### Page Markers
```
[PAGE:1]
Content of page 1...

[PAGE:2]
Content of page 2...
```

#### Chapter Markers
Automatically detects Vietnamese chapter patterns:
```
[CHAPTER:Chương 1: Giới thiệu]
[CHAPTER:Phần I: Cơ bản]
[CHAPTER:Bài 1: Khái niệm]
```

#### Section Markers
```
[SECTION:1.1 Định nghĩa]
[SECTION:1.2 Ví dụ]
```

### 🧹 Text Cleaning
- Removes page numbers and headers/footers
- Normalizes whitespace
- Filters out common PDF artifacts

### 🔍 Chapter Detection
Supports various Vietnamese chapter patterns:
- `Chương 1`, `CHƯƠNG I`
- `Phần 1`, `PHẦN I`
- `Bài 1`, `BÀI 1`
- `Chapter 1`, `CHAPTER 1`
- Numbered sections like `1. Introduction`

## Example Output Format

```
[CHAPTER:Chương 1: Giới thiệu về Lập trình]
[PAGE:1]
Lập trình là quá trình tạo ra các chương trình máy tính bằng cách viết mã nguồn.
Trong chương này, chúng ta sẽ tìm hiểu về các khái niệm cơ bản của lập trình.

[SECTION:1.1 Khái niệm cơ bản]
Lập trình viên sử dụng các ngôn ngữ lập trình để giao tiếp với máy tính.

[PAGE:2]
Có nhiều ngôn ngữ lập trình khác nhau như Python, JavaScript, Java, C++...

[CHAPTER:Chương 2: Ngôn ngữ lập trình Python]
[PAGE:3]
Python là một ngôn ngữ lập trình bậc cao, dễ học và mạnh mẽ.
```

## Integration with Reading System

After processing, the extracted text files are automatically compatible with the reading system:

1. **Enhanced Navigation**: Page and chapter markers enable precise navigation
2. **Better Search**: Search results include chapter and section context
3. **Reading Progress**: Accurate page tracking based on original PDF pages
4. **Vietnamese Support**: Full support for Vietnamese text in all reading modes

## Workflow

### 1. Prepare PDF Files
- Ensure PDFs are text-selectable (not scanned images)
- Place PDF files in the `input/` directory
- Use descriptive filenames (will become book names)

### 2. Extract Text
```bash
python extract_pdf.py
```

### 3. Verify Output
- Check `output/` directory for generated `.txt` files
- Verify Vietnamese text is properly encoded
- Check that chapters and pages are correctly marked

### 4. Use in Reading System
The extracted files are automatically available in the reading system:
```javascript
// Check if book exists
ReadingManager(supabase, userId, "History", "Check", "your_book_name")

// Start reading
ReadingManager(supabase, userId, "Read", "Start", "your_book_name")

// Search in book
ReadingManager(supabase, userId, "Search", "Find", "your_book_name", null, "từ khóa")
```

## Troubleshooting

### Common Issues

#### 1. Empty Output Files
- **Cause**: PDF contains scanned images instead of text
- **Solution**: Use OCR tools to convert images to text first

#### 2. Garbled Vietnamese Text
- **Cause**: Encoding issues
- **Solution**: Ensure PDF uses standard fonts and encoding

#### 3. Missing Chapters
- **Cause**: Chapter titles don't match detection patterns
- **Solution**: Modify chapter patterns in `extract_pdf.py`

#### 4. Large Files
- **Cause**: PDF contains many images or complex formatting
- **Solution**: Use `--file` option to process one at a time

### Customization

#### Adding New Chapter Patterns
Edit the `chapter_patterns` list in `extract_pdf.py`:
```python
self.chapter_patterns = [
    r'^(Chương|CHƯƠNG)\s+(\d+|[IVXLCDM]+)[\s\.:]*(.*)$',
    r'^(Mục|MỤC)\s+(\d+)[\s\.:]*(.*)$',  # Add custom pattern
    # ... other patterns
]
```

#### Adjusting Text Cleaning
Modify the `clean_text` method to handle specific PDF formatting issues.

## Performance

- **Speed**: ~1-2 pages per second for typical Vietnamese books
- **Memory**: Processes one page at a time to minimize memory usage
- **File Size**: Output text files are typically 10-20% of original PDF size

## Best Practices

1. **File Naming**: Use descriptive names without spaces or special characters
2. **Quality Check**: Always verify a few pages of output before bulk processing
3. **Backup**: Keep original PDF files as backup
4. **Testing**: Test with a small PDF first to verify Vietnamese text handling

## Future Enhancements

- OCR support for scanned PDFs
- Table extraction and formatting
- Image description extraction
- Automatic book metadata detection
- Batch processing with progress bars
- GUI interface for non-technical users
