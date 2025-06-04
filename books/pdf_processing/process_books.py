#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Batch PDF Processing Script for Vietnamese Books
Processes multiple PDF files and integrates them with the reading system.
"""

import os
import sys
import json
import sqlite3
from pathlib import Path
from datetime import datetime
from extract_pdf import VietnamesePDFExtractor

class BookProcessor:
    def __init__(self, input_dir="input", output_dir="output"):
        self.input_dir = Path(input_dir)
        self.output_dir = Path(output_dir)
        self.extractor = VietnamesePDFExtractor()
        self.processed_books = []
        
    def count_pages_in_text(self, text_file: str) -> int:
        """Count the number of pages in extracted text file."""
        try:
            with open(text_file, 'r', encoding='utf-8') as f:
                content = f.read()
            
            # Count page markers
            page_count = content.count('[PAGE:')
            return page_count if page_count > 0 else 1
        except Exception:
            return 1
    
    def extract_book_info(self, text_file: str) -> dict:
        """Extract book metadata from the text file."""
        try:
            with open(text_file, 'r', encoding='utf-8') as f:
                content = f.read()
            
            # Extract first chapter as potential title
            title = None
            first_chapter_match = content.find('[CHAPTER:')
            if first_chapter_match != -1:
                end_match = content.find(']', first_chapter_match)
                if end_match != -1:
                    title = content[first_chapter_match + 9:end_match]
            
            # Count chapters
            chapter_count = content.count('[CHAPTER:')
            
            # Get first few lines as description
            lines = content.split('\n')
            description_lines = []
            for line in lines:
                if line.strip() and not line.startswith('['):
                    description_lines.append(line.strip())
                    if len(description_lines) >= 3:
                        break
            
            description = ' '.join(description_lines)[:200] + "..." if description_lines else ""
            
            return {
                'title': title,
                'chapter_count': chapter_count,
                'description': description
            }
        except Exception:
            return {'title': None, 'chapter_count': 0, 'description': ''}
    
    def process_all_pdfs(self) -> dict:
        """Process all PDF files in the input directory."""
        if not self.input_dir.exists():
            print(f"❌ Input directory does not exist: {self.input_dir}")
            return {'success': False, 'processed': 0, 'failed': 0}
        
        self.output_dir.mkdir(parents=True, exist_ok=True)
        
        pdf_files = list(self.input_dir.glob("*.pdf"))
        if not pdf_files:
            print(f"📁 No PDF files found in {self.input_dir}")
            return {'success': True, 'processed': 0, 'failed': 0}
        
        print(f"📚 Found {len(pdf_files)} PDF files to process")
        print("=" * 50)
        
        processed_count = 0
        failed_count = 0
        
        for pdf_file in pdf_files:
            print(f"\n📖 Processing: {pdf_file.name}")
            
            # Generate output filename
            book_name = pdf_file.stem
            output_file = self.output_dir / f"{book_name}.txt"
            
            # Extract text
            success = self.extractor.extract_text_from_pdf(str(pdf_file), str(output_file))
            
            if success:
                # Count pages and extract metadata
                page_count = self.count_pages_in_text(str(output_file))
                book_info = self.extract_book_info(str(output_file))
                
                book_data = {
                    'book_name': book_name,
                    'original_file': str(pdf_file),
                    'output_file': str(output_file),
                    'page_count': page_count,
                    'title': book_info['title'],
                    'chapter_count': book_info['chapter_count'],
                    'description': book_info['description'],
                    'processed_at': datetime.now().isoformat(),
                    'file_size': pdf_file.stat().st_size,
                    'output_size': output_file.stat().st_size
                }
                
                self.processed_books.append(book_data)
                
                print(f"✅ {pdf_file.name} -> {output_file.name}")
                print(f"   📄 Pages: {page_count}")
                print(f"   📚 Chapters: {book_info['chapter_count']}")
                if book_info['title']:
                    print(f"   📝 Title: {book_info['title'][:50]}...")
                
                processed_count += 1
            else:
                print(f"❌ Failed to process {pdf_file.name}")
                failed_count += 1
        
        # Save processing report
        self.save_processing_report()
        
        print("\n" + "=" * 50)
        print(f"📊 Processing Summary:")
        print(f"   ✅ Processed: {processed_count}")
        print(f"   ❌ Failed: {failed_count}")
        print(f"   📁 Output directory: {self.output_dir}")
        
        return {
            'success': True,
            'processed': processed_count,
            'failed': failed_count,
            'books': self.processed_books
        }
    
    def save_processing_report(self):
        """Save a JSON report of processed books."""
        report_file = self.output_dir / "processing_report.json"
        
        report = {
            'processed_at': datetime.now().isoformat(),
            'total_books': len(self.processed_books),
            'books': self.processed_books
        }
        
        with open(report_file, 'w', encoding='utf-8') as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        
        print(f"📋 Processing report saved: {report_file}")
    
    def generate_book_catalog(self):
        """Generate a catalog of available books."""
        catalog_file = self.output_dir / "book_catalog.md"
        
        with open(catalog_file, 'w', encoding='utf-8') as f:
            f.write("# Thư viện Sách Điện tử\n\n")
            f.write(f"Tổng số sách: {len(self.processed_books)}\n")
            f.write(f"Cập nhật lần cuối: {datetime.now().strftime('%d/%m/%Y %H:%M')}\n\n")
            
            for book in self.processed_books:
                f.write(f"## {book['book_name']}\n")
                if book['title']:
                    f.write(f"**Tiêu đề:** {book['title']}\n\n")
                f.write(f"**Số trang:** {book['page_count']}\n\n")
                f.write(f"**Số chương:** {book['chapter_count']}\n\n")
                if book['description']:
                    f.write(f"**Mô tả:** {book['description']}\n\n")
                f.write(f"**File gốc:** {Path(book['original_file']).name}\n\n")
                f.write("---\n\n")
        
        print(f"📖 Book catalog generated: {catalog_file}")

def main():
    import argparse
    
    parser = argparse.ArgumentParser(description="Batch process Vietnamese PDF books")
    parser.add_argument("--input", "-i", 
                       default="input", 
                       help="Input directory containing PDF files")
    parser.add_argument("--output", "-o", 
                       default="output", 
                       help="Output directory for extracted text files")
    parser.add_argument("--catalog", "-c", 
                       action="store_true",
                       help="Generate book catalog after processing")
    
    args = parser.parse_args()
    
    processor = BookProcessor(args.input, args.output)
    
    print("🚀 Vietnamese PDF Book Processor")
    print("=" * 50)
    
    result = processor.process_all_pdfs()
    
    if result['success'] and result['processed'] > 0:
        if args.catalog:
            processor.generate_book_catalog()
        
        print("\n🎉 Processing completed successfully!")
        print("\n📋 Next steps:")
        print("1. Check the output files in the output/ directory")
        print("2. Verify Vietnamese text is properly encoded")
        print("3. Test reading a few pages in the reading system")
        print("4. The books are now available in your reading system!")
        
    elif result['failed'] > 0:
        print(f"\n⚠️  Some files failed to process. Check the error messages above.")
        sys.exit(1)
    else:
        print("\n📁 No files to process.")

if __name__ == "__main__":
    main()
