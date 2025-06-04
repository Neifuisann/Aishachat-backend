#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PDF Text Extraction Tool for Vietnamese Books
Extracts text from PDF files and adds navigation markers for the reading system.
"""

import os
import re
import sys
import argparse
from pathlib import Path
from typing import List, Tuple, Optional

try:
    import pdfplumber
except ImportError:
    print("Error: pdfplumber is required. Install it with: pip install pdfplumber")
    sys.exit(1)

class VietnamesePDFExtractor:
    def __init__(self):
        self.chapter_patterns = [
            r'^(Chương|CHƯƠNG)\s+(\d+|[IVXLCDM]+)[\s\.:]*(.*)$',
            r'^(Chapter|CHAPTER)\s+(\d+|[IVXLCDM]+)[\s\.:]*(.*)$',
            r'^(Phần|PHẦN)\s+(\d+|[IVXLCDM]+)[\s\.:]*(.*)$',
            r'^(Bài|BÀI)\s+(\d+|[IVXLCDM]+)[\s\.:]*(.*)$',
            r'^(\d+)[\.\s]+(.{1,50})$',  # Numbered chapters like "1. Introduction"
        ]
        
        self.section_patterns = [
            r'^(\d+\.\d+)[\s\.:]+(.*)$',  # 1.1 Section
            r'^([A-Z][A-Z\s]{2,30})$',   # ALL CAPS headings
        ]

    def clean_text(self, text: str) -> str:
        """Clean and normalize Vietnamese text."""
        if not text:
            return ""
        
        # Remove excessive whitespace
        text = re.sub(r'\s+', ' ', text)
        
        # Remove page numbers and headers/footers (common patterns)
        text = re.sub(r'^\s*\d+\s*$', '', text, flags=re.MULTILINE)
        text = re.sub(r'^\s*Page\s+\d+\s*$', '', text, flags=re.MULTILINE)
        text = re.sub(r'^\s*Trang\s+\d+\s*$', '', text, flags=re.MULTILINE)
        
        # Remove excessive line breaks
        text = re.sub(r'\n\s*\n\s*\n+', '\n\n', text)
        
        return text.strip()

    def detect_chapter(self, line: str) -> Optional[Tuple[str, str]]:
        """Detect if a line is a chapter heading."""
        line = line.strip()
        if not line or len(line) > 100:  # Too long to be a chapter title
            return None
            
        for pattern in self.chapter_patterns:
            match = re.match(pattern, line, re.IGNORECASE)
            if match:
                if len(match.groups()) >= 3:
                    chapter_type = match.group(1)
                    chapter_num = match.group(2)
                    chapter_title = match.group(3).strip()
                    full_title = f"{chapter_type} {chapter_num}"
                    if chapter_title:
                        full_title += f": {chapter_title}"
                    return ("CHAPTER", full_title)
                elif len(match.groups()) >= 2:
                    return ("CHAPTER", f"{match.group(1)} {match.group(2)}")
        
        return None

    def detect_section(self, line: str) -> Optional[Tuple[str, str]]:
        """Detect if a line is a section heading."""
        line = line.strip()
        if not line or len(line) > 80:
            return None
            
        for pattern in self.section_patterns:
            match = re.match(pattern, line)
            if match:
                if len(match.groups()) >= 2:
                    return ("SECTION", f"{match.group(1)} {match.group(2)}")
                else:
                    return ("SECTION", match.group(1))
        
        return None

    def extract_text_from_pdf(self, pdf_path: str, output_path: str) -> bool:
        """Extract text from PDF and save with navigation markers."""
        try:
            print(f"Processing: {pdf_path}")
            
            with pdfplumber.open(pdf_path) as pdf:
                total_pages = len(pdf.pages)
                print(f"Total pages: {total_pages}")
                
                extracted_content = []
                current_chapter = None
                
                for page_num, page in enumerate(pdf.pages, 1):
                    print(f"Processing page {page_num}/{total_pages}...", end='\r')
                    
                    # Extract text from page
                    page_text = page.extract_text()
                    if not page_text:
                        continue
                    
                    # Clean the text
                    page_text = self.clean_text(page_text)
                    if not page_text:
                        continue
                    
                    # Split into lines for analysis
                    lines = page_text.split('\n')
                    page_content = []
                    
                    for line in lines:
                        line = line.strip()
                        if not line:
                            continue
                        
                        # Check for chapter heading
                        chapter_match = self.detect_chapter(line)
                        if chapter_match:
                            if current_chapter != chapter_match[1]:
                                current_chapter = chapter_match[1]
                                page_content.append(f"[CHAPTER:{current_chapter}]")
                            continue
                        
                        # Check for section heading
                        section_match = self.detect_section(line)
                        if section_match:
                            page_content.append(f"[SECTION:{section_match[1]}]")
                            continue
                        
                        # Regular content
                        page_content.append(line)
                    
                    # Add page marker and content
                    if page_content:
                        extracted_content.append(f"[PAGE:{page_num}]")
                        extracted_content.extend(page_content)
                        extracted_content.append("")  # Empty line after page
                
                print(f"\nExtraction completed. Writing to: {output_path}")
                
                # Write to output file with UTF-8 encoding
                with open(output_path, 'w', encoding='utf-8') as f:
                    f.write('\n'.join(extracted_content))
                
                print(f"Successfully extracted {total_pages} pages to {output_path}")
                return True
                
        except Exception as e:
            print(f"Error processing {pdf_path}: {str(e)}")
            return False

    def process_directory(self, input_dir: str, output_dir: str) -> None:
        """Process all PDF files in input directory."""
        input_path = Path(input_dir)
        output_path = Path(output_dir)
        
        if not input_path.exists():
            print(f"Input directory does not exist: {input_dir}")
            return
        
        output_path.mkdir(parents=True, exist_ok=True)
        
        pdf_files = list(input_path.glob("*.pdf"))
        if not pdf_files:
            print(f"No PDF files found in {input_dir}")
            return
        
        print(f"Found {len(pdf_files)} PDF files to process")
        
        for pdf_file in pdf_files:
            output_file = output_path / f"{pdf_file.stem}.txt"
            success = self.extract_text_from_pdf(str(pdf_file), str(output_file))
            
            if success:
                print(f"✅ {pdf_file.name} -> {output_file.name}")
            else:
                print(f"❌ Failed to process {pdf_file.name}")

def main():
    parser = argparse.ArgumentParser(description="Extract text from Vietnamese PDF books")
    parser.add_argument("--input", "-i", 
                       default="input", 
                       help="Input directory containing PDF files (default: input)")
    parser.add_argument("--output", "-o", 
                       default="output", 
                       help="Output directory for extracted text files (default: output)")
    parser.add_argument("--file", "-f", 
                       help="Process a single PDF file")
    
    args = parser.parse_args()
    
    extractor = VietnamesePDFExtractor()
    
    if args.file:
        # Process single file
        if not os.path.exists(args.file):
            print(f"File not found: {args.file}")
            sys.exit(1)
        
        output_file = f"{Path(args.file).stem}.txt"
        if args.output != "output":
            output_file = os.path.join(args.output, output_file)
        
        success = extractor.extract_text_from_pdf(args.file, output_file)
        if success:
            print(f"✅ Successfully processed {args.file}")
        else:
            print(f"❌ Failed to process {args.file}")
            sys.exit(1)
    else:
        # Process directory
        extractor.process_directory(args.input, args.output)

if __name__ == "__main__":
    main()
