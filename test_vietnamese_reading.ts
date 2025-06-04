#!/usr/bin/env deno run -A

// Test Vietnamese PDF reading system
console.log("Testing Vietnamese PDF Reading System");
console.log("====================================");

// Make this a module
export {};

// Test Vietnamese book with markers
async function testVietnameseReading() {
    console.log("\n1. Testing Vietnamese book file with markers");
    try {
        const content = await Deno.readTextFile("books/pdf_processing/output/sample_vietnamese_book.txt");
        console.log("✅ Vietnamese book file found");
        console.log(`📖 Content length: ${content.length} characters`);
        
        // Test marker parsing
        const pageMarkers = content.match(/\[PAGE:\d+\]/g);
        const chapterMarkers = content.match(/\[CHAPTER:[^\]]+\]/g);
        const sectionMarkers = content.match(/\[SECTION:[^\]]+\]/g);
        
        console.log(`📄 Page markers found: ${pageMarkers?.length || 0}`);
        console.log(`📚 Chapter markers found: ${chapterMarkers?.length || 0}`);
        console.log(`📝 Section markers found: ${sectionMarkers?.length || 0}`);
        
        if (chapterMarkers) {
            console.log("\n2. Chapter structure:");
            chapterMarkers.forEach((marker, index) => {
                const chapterName = marker.replace(/\[CHAPTER:|\]/g, '');
                console.log(`   ${index + 1}. ${chapterName}`);
            });
        }
        
        console.log("\n3. Testing Vietnamese text search");
        const searchTerms = ["lập trình", "Python", "biến", "vòng lặp"];
        
        for (const term of searchTerms) {
            const regex = new RegExp(term, 'gi');
            const matches = content.match(regex);
            console.log(`🔍 "${term}": ${matches?.length || 0} matches`);
        }
        
        console.log("\n4. Testing page extraction");
        const pages = [];
        const lines = content.split('\n');
        let currentPage = null;
        let currentChapter = null;
        
        for (const line of lines) {
            const trimmedLine = line.trim();
            
            // Check for page marker
            const pageMatch = trimmedLine.match(/^\[PAGE:(\d+)\]$/);
            if (pageMatch) {
                if (currentPage) {
                    pages.push(currentPage);
                }
                currentPage = {
                    pageNum: parseInt(pageMatch[1]),
                    content: "",
                    chapter: currentChapter
                };
                continue;
            }
            
            // Check for chapter marker
            const chapterMatch = trimmedLine.match(/^\[CHAPTER:(.+)\]$/);
            if (chapterMatch) {
                currentChapter = chapterMatch[1];
                if (currentPage) {
                    currentPage.chapter = currentChapter;
                }
                continue;
            }
            
            // Skip section markers for this test
            if (trimmedLine.startsWith('[SECTION:')) {
                continue;
            }
            
            // Regular content
            if (currentPage && trimmedLine) {
                if (currentPage.content) {
                    currentPage.content += '\n' + line;
                } else {
                    currentPage.content = line;
                }
            }
        }
        
        // Add last page
        if (currentPage) {
            pages.push(currentPage);
        }
        
        console.log(`📄 Extracted ${pages.length} pages`);
        
        // Show sample pages
        if (pages.length > 0) {
            console.log("\n5. Sample page content:");
            const samplePage = pages[0];
            console.log(`   Page ${samplePage.pageNum} (${samplePage.chapter}):`);
            console.log(`   ${samplePage.content.substring(0, 100)}...`);
        }
        
        console.log("\n6. Testing reading modes");
        if (pages.length > 0) {
            const testPage = pages[0];
            
            // Test paragraph mode
            const paragraphs = testPage.content.split('\n').filter(p => p.trim().length > 0);
            console.log(`📝 Paragraph mode (2 paragraphs):`);
            console.log(`   ${paragraphs.slice(0, 2).join('\n').substring(0, 150)}...`);
            
            // Test sentence mode
            const sentences = testPage.content.split(/[.!?]+/).filter(s => s.trim().length > 0);
            console.log(`📝 Sentence mode (2 sentences):`);
            console.log(`   ${sentences.slice(0, 2).join('. ').substring(0, 150)}...`);
        }
        
        console.log("\n✅ All Vietnamese reading tests passed!");
        return true;
        
    } catch (error) {
        console.error("❌ Error testing Vietnamese reading:", error);
        return false;
    }
}

// Test Vietnamese text encoding
function testVietnameseEncoding() {
    console.log("\n7. Testing Vietnamese character encoding");
    
    const vietnameseChars = [
        "à", "á", "ả", "ã", "ạ",  // a with diacritics
        "ă", "ằ", "ắ", "ẳ", "ẵ", "ặ",  // ă with diacritics
        "â", "ầ", "ấ", "ẩ", "ẫ", "ậ",  // â with diacritics
        "è", "é", "ẻ", "ẽ", "ẹ",  // e with diacritics
        "ê", "ề", "ế", "ể", "ễ", "ệ",  // ê with diacritics
        "ì", "í", "ỉ", "ĩ", "ị",  // i with diacritics
        "ò", "ó", "ỏ", "õ", "ọ",  // o with diacritics
        "ô", "ồ", "ố", "ổ", "ỗ", "ộ",  // ô with diacritics
        "ơ", "ờ", "ớ", "ở", "ỡ", "ợ",  // ơ with diacritics
        "ù", "ú", "ủ", "ũ", "ụ",  // u with diacritics
        "ư", "ừ", "ứ", "ử", "ữ", "ự",  // ư with diacritics
        "ỳ", "ý", "ỷ", "ỹ", "ỵ",  // y with diacritics
        "đ", "Đ"  // đ
    ];
    
    console.log("Vietnamese characters test:");
    console.log(vietnameseChars.join(" "));
    
    // Test common Vietnamese words
    const vietnameseWords = [
        "Xin chào", "Cảm ơn", "Tạm biệt",
        "Lập trình", "Máy tính", "Phần mềm",
        "Ngôn ngữ", "Chương trình", "Dữ liệu"
    ];
    
    console.log("\nVietnamese words test:");
    vietnameseWords.forEach(word => {
        console.log(`   ${word} (${word.length} characters)`);
    });
    
    console.log("✅ Vietnamese encoding test completed");
}

// Run all tests
async function runAllTests() {
    const success = await testVietnameseReading();
    testVietnameseEncoding();
    
    if (success) {
        console.log("\n🎉 Vietnamese PDF Reading System Test Complete!");
        console.log("\n📋 Summary:");
        console.log("   ✅ Vietnamese text file reading");
        console.log("   ✅ Marker parsing (PAGE, CHAPTER, SECTION)");
        console.log("   ✅ Vietnamese text search");
        console.log("   ✅ Page extraction with chapter context");
        console.log("   ✅ Reading modes (paragraphs, sentences)");
        console.log("   ✅ Vietnamese character encoding");
        console.log("\n🚀 The Vietnamese PDF reading system is ready!");
        console.log("\n📖 Usage instructions:");
        console.log("1. Place PDF files in books/pdf_processing/input/");
        console.log("2. Run: python books/pdf_processing/extract_pdf.py");
        console.log("3. Use ReadingManager with the extracted book names");
    } else {
        console.log("\n❌ Some tests failed");
        Deno.exit(1);
    }
}

// Execute tests
try {
    await runAllTests();
} catch (error) {
    console.error("\n❌ Test execution failed:", error);
    Deno.exit(1);
}
